import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { renderConfig, syncConfig } from "../boot/config.ts";
import { startGateway } from "../boot/process.ts";

// The real gateway: /app in the image (CI), node_modules here. Only a patched one has a standby.
const require = createRequire(new URL("../plugin/package.json", import.meta.url));
let openclaw = dirname(require.resolve("openclaw"));
while (!existsSync(join(openclaw, "openclaw.mjs"))) openclaw = dirname(openclaw);
const patched = existsSync(join(openclaw, "dist/plow-standby.mjs"));
const repo = new URL("..", import.meta.url).pathname;

const freePort = () => new Promise<number>(resolve => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as net.AddressInfo;
    server.close(() => resolve(port));
  });
});
const until = async (what: string, ready: () => boolean, ms = 120_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (ready()) return;
  throw new Error(`timed out waiting for ${what}`);
};
const healthy = (port: number) => new Promise<boolean>(resolve => {
  const request = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 30_000 }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => resolve(response.statusCode === 200 && body.includes('"live"')));
  });
  request.on("error", () => resolve(false));
  request.on("timeout", () => { request.destroy(); resolve(false); });
});

// One owner chat on a fake Plow, and a model on the same server that answers "ack m<n>" to "m<n>: ...".
async function fakePlow() {
  const { WebSocketServer } = require("ws");
  const owner = { type: "member", uid: "mem_owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const self = { type: "agent", relationship: "self", line: { uid: "ln_takeover", display_name: "Probe" } };
  const chat = { uid: "cht_owner", status: "active", trusted: false, display_name: "Owner", participants: [owner, self] };
  const messages: Record<string, unknown>[] = [];
  const posted: string[] = [];
  const turns: string[][] = [];
  const sockets = new Set<{ send: (data: string) => void; terminate: () => void }>();
  const json = (response: http.ServerResponse, status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const text = (content: unknown) => typeof content === "string" ? content : (content as { type: string; text?: string }[] ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url!, "http://plow");
    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /v1/ws/ticket") return json(response, 200, { ticket: "fixture" });
    if (route === "GET /v1/chats") return json(response, 200, { data: [chat], has_more: false });
    if (route === "GET /v1/chats/cht_owner") return json(response, 200, chat);
    if (route === "POST /v1/chats/cht_owner/typing") return json(response, 200, {});
    if (route === "GET /v1/chats/cht_owner/messages") {
      const after = url.searchParams.get("starting_after");
      const from = after ? messages.findIndex(message => message.uid === after) + 1 : 0;
      return json(response, 200, { data: messages.slice(from, from + Number(url.searchParams.get("limit") ?? 50)), has_more: false });
    }
    if (route === "POST /v1/chats/cht_owner/messages") {
      const sent = JSON.parse(body);
      posted.push(sent.body);
      const uid = `msg_out_${posted.length}`;
      messages.unshift({ uid, direction: "outbound", sender: self, body: sent.body, attachments: [], created_at: new Date().toISOString() });
      return json(response, 201, { uid });
    }
    if (route === "POST /v1/chat/completions") {
      const completion = JSON.parse(body);
      // Owner turns only; OpenClaw's internal context also quotes Plow's history.
      const users = completion.messages.filter((message: { role: string }) => message.role === "user").map((message: { content: unknown }) => text(message.content)).filter((user: string) => !user.includes("OPENCLAW_INTERNAL_CONTEXT"));
      turns.push(users);
      const said = [...users].reverse().map((user: string) => [...user.matchAll(/\b(m\d+): /g)].at(-1)?.[1]).find(Boolean);
      const content = said ? `ack ${said}` : "ok";
      if (!completion.stream) return json(response, 200, { id: "c", object: "chat.completion", created: 0, model: completion.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [{ delta: { role: "assistant", content }, finish_reason: null }, { delta: {}, finish_reason: "stop" }]) response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: completion.model, choices: [{ index: 0, ...choice }] })}\n\n`);
      return response.end("data: [DONE]\n\n");
    }
    json(response, 404, {});
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, (ws: { send: (data: string) => void; terminate: () => void; on: (event: string, listener: () => void) => void }) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let sent = 0;
  return {
    apiBase: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    posted, turns, sockets,
    send(body: string) {
      const message = { uid: `msg_in_${++sent}`, direction: "inbound", sender: owner, body, attachments: [], created_at: new Date().toISOString() };
      messages.unshift(message);
      for (const ws of sockets) ws.send(JSON.stringify({ event_type: "message_received", event_id: `evt_${message.uid}`, chat_id: "cht_owner", data: { message } }));
    },
    close() { for (const ws of sockets) ws.terminate(); server.close(); },
  };
}

test("a standby gateway takes over the same state with no lost message and a short gap", { timeout: 300_000, skip: !patched && "this OpenClaw is unpatched (the image applies patches/openclaw-standby.ts)" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "plow-takeover-"));
  const plow = await fakePlow();
  const [front, first, second] = [await freePort(), await freePort(), await freePort()];
  const config = renderConfig({ agent: { name: "Probe" }, line: { uid: "ln_takeover" }, chats: [] } as never, plow.apiBase);
  config.agents.defaults.workspace = join(root, "workspace");
  config.plugins.load.paths = [join(repo, "plugin")];
  config.gateway.port = front;
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  await writeFile(join(root, "workspace/AGENTS.md"), "You are a test agent.\n");
  await syncConfig(config, join(root, "openclaw.json"), join(root, "include"));
  const env: Record<string, string> = {
    HOME: join(root, "home"), OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"), OPENCLAW_INCLUDE_ROOTS: join(root, "include"),
    OPENCLAW_NO_RESPAWN: "1", NODE_DISABLE_COMPILE_CACHE: "1", PLOW_AGENT_TOKEN: "takeover-fixture", OPENCLAW_GATEWAY_PASSWORD: "takeover-fixture-password",
    OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
    // The first gateway records the modules the standby preloads, as the image build does.
    OPENCLAW_GATEWAY_WARM_RECORD: join(root, "warm-modules.txt"), NODE_OPTIONS: `--import ${new URL("../boot/warm-record.ts", import.meta.url).href}`,
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let output = "";
  const events: { at: number; line: string }[] = [];
  t.mock.method(console, "error", (line: unknown) => { events.push({ at: performance.now(), line: String(line) }); });
  // The test runner reports on SIGUSR2, through a listener process.emit would also call.
  const reportOnSignal = process.report.reportOnSignal;
  process.report.reportOnSignal = false;
  const connected = () => output.split("connected account=chat").length - 1;
  t.after(async () => {
    process.emit("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 3_000));
    plow.close();
    process.report.reportOnSignal = reportOnSignal;
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const booted = performance.now();
  await startGateway(true, undefined, chunk => { output += chunk; }, { frontPort: front, ports: [first, second], entry: join(openclaw, "openclaw.mjs"), warmModules: join(root, "warm-modules.txt") });
  await until("the first gateway to connect to Plow", () => connected() === 1 && plow.sockets.size === 1);
  const coldBoot = performance.now() - booted;
  delete process.env.NODE_OPTIONS;
  delete process.env.OPENCLAW_GATEWAY_WARM_RECORD;
  plow.send("m1: remember the number 47");
  await until("m1's reply", () => plow.posted.includes("ack m1"));
  assert.ok((await readFile(join(root, "warm-modules.txt"), "utf8")).split("\n").length > 100, "the first boot recorded what to preload");

  process.emit("SIGUSR2");
  await until("the standby to be warm", () => events.some(event => event.line.includes("standby gateway warm")));
  const stopped = events.find(event => event.line.includes("standby gateway warm"))!.at;
  // Sent while neither gateway listens to Plow: the new one must replay it from history.
  await new Promise(resolve => setTimeout(resolve, 150));
  plow.send("m2: sent during the takeover");
  await until("the standby to connect to Plow", () => connected() === 2 && plow.sockets.size === 1);
  const gap = performance.now() - stopped;
  assert.equal(await healthy(front), true, "the public port reaches the new gateway");
  await until("m2's reply", () => plow.posted.includes("ack m2"));
  plow.send("m3: what number did I ask you to remember?");
  await until("m3's reply", () => plow.posted.includes("ack m3"));

  t.diagnostic(`takeover gap (old gateway told to stop -> new gateway connected to Plow): ${Math.round(gap)} ms; the first gateway's cold boot, recording its preload list: ${Math.round(coldBoot)} ms`);
  // What the new gateway still does after it takes the lock (OPENCLAW_GATEWAY_STARTUP_TRACE).
  const afterLock = output.slice(output.lastIndexOf("state ownership acquired")).replace(/\x1b\[[0-9;]*m/g, "");
  t.diagnostic("after the lock: " + [...afterLock.matchAll(/startup trace: (\S+) ([0-9.]+)ms/g)].filter(([, name, ms]) => Number(ms) >= 150 && !name.startsWith("process.")).map(([, name, ms]) => `${name} ${Math.round(Number(ms))}`).join(", "));
  t.diagnostic(output.split("\n").find(line => line.includes("standby: warm"))?.replace(/\x1b\[[0-9;]*m/g, "").trim() ?? "no preload line");
  assert.deepEqual(plow.posted.filter(body => /^ack m\d$/.test(body)).sort(), ["ack m1", "ack m2", "ack m3"], "one reply each, none lost or doubled");
  assert.ok(plow.turns.at(-1)!.some(user => user.includes("remember the number 47")), "the new gateway continues the same session");
  assert.ok(events.some(event => /replaced gateway exited code=0/.test(event.line)), "the old gateway stopped cleanly");
  assert.ok(gap < 30_000, `takeover took ${Math.round(gap)} ms`);
  process.emit("SIGTERM");
  await until("the new gateway, started with an IPC channel, to stop cleanly", () => events.some(event => /^plow-boot: gateway exited code=0/.test(event.line)));
});
