import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { renderConfig } from "../boot/config.ts";
import { identityFromApi } from "../boot/identity.ts";
import { startGateway } from "../boot/process.ts";
import { renderPrompt } from "../boot/prompt.ts";

type FakeChild = EventEmitter & { args: string[]; kill: (signal: string) => void; signals: string[] };

function fakeSupervisor(t: TestContext) {
  const listeners = process.listenerCount("SIGTERM");
  const previousCode = process.exitCode;
  const children: FakeChild[] = [];
  const options: SpawnOptions[] = [];
  const errors: string[] = [];
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  // The test runner reports on SIGUSR2, through a listener process.emit would also call.
  const reportOnSignal = process.report.reportOnSignal;
  process.report.reportOnSignal = false;
  t.mock.method(console, "error", (line: unknown) => { errors.push(String(line)); });
  t.mock.method(childProcess, "spawn", (_command: string, args: string[], opts: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { args, signals: [] as string[], kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null, signal)); } });
    children.push(child); options.push(opts);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    process.emit("SIGTERM");
    t.mock.timers.reset(); t.mock.restoreAll(); syncBuiltinESMExports();
    process.exitCode = previousCode;
    process.report.reportOnSignal = reportOnSignal;
  });
  const gateways = () => children.filter(child => child.args[0] === "/app/openclaw.mjs");
  return { children, options, errors, gateways, listeners, previousCode };
}

test("supervisor stops the gateway on SIGTERM and releases its signal handlers", async t => {
  const { children, listeners, previousCode } = fakeSupervisor(t);
  assert.equal(await startGateway(true), children[0]);
  process.emit("SIGTERM");
  await setImmediate();
  assert.ok(children[0].signals.includes("SIGTERM"));
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(process.exitCode, previousCode);
});

for (const [code, signal] of [[0, null], [1, null], [null, "SIGKILL"]] as const) test(`supervisor restarts a gateway that exits code=${code} signal=${signal}`, async t => {
  const { errors, gateways } = fakeSupervisor(t);
  await startGateway(true);
  gateways()[0].emit("close", code, signal);
  assert.equal(errors.at(-1), `plow-boot: gateway exited code=${code} signal=${signal}; restarting in 1s`);
  t.mock.timers.tick(999);
  assert.equal(gateways().length, 1);
  t.mock.timers.tick(1);
  assert.equal(gateways().length, 2, "the gateway comes back");
});

test("supervisor backs off gateway restarts to a minute, and resets after a healthy run", async t => {
  const { errors, gateways } = fakeSupervisor(t);
  await startGateway(true);
  const delays: string[] = [];
  for (let i = 0; i < 8; i++) {
    gateways().at(-1)!.emit("close", null, "SIGKILL");
    delays.push(errors.at(-1)!.split("restarting in ")[1]);
    t.mock.timers.tick(60_000);
  }
  assert.deepEqual(delays, ["1s", "2s", "4s", "8s", "16s", "32s", "60s", "60s"]);
  assert.equal(gateways().length, 9);
  t.mock.timers.tick(5 * 60_000);
  gateways().at(-1)!.emit("close", null, "SIGKILL");
  assert.match(errors.at(-1)!, /restarting in 1s$/);
});

test("supervisor shutdown cancels a pending gateway restart", async t => {
  const { errors, gateways, listeners } = fakeSupervisor(t);
  await startGateway(true);
  gateways()[0].emit("close", 1, null);
  process.emit("SIGTERM");
  t.mock.timers.tick(60_000);
  assert.equal(gateways().length, 1, "no gateway after shutdown");
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(errors.length, 1);
});

test("supervisor logs a gateway exit during shutdown and does not restart it", async t => {
  const { children, errors, gateways, listeners } = fakeSupervisor(t);
  await startGateway(true);
  process.emit("SIGTERM");
  await setImmediate();
  assert.deepEqual(children.map(child => child.signals), [["SIGTERM"]]);
  assert.deepEqual(errors, ["plow-boot: gateway exited code=null signal=SIGTERM"]);
  t.mock.timers.tick(60_000);
  assert.equal(gateways().length, 1);
  assert.equal(process.listenerCount("SIGTERM"), listeners);
});

const warm = (child: FakeChild) => child.emit("message", "warm");
const takeoverOptions = (prepare = async () => {}) => ({ frontPort: 0, ports: [4101, 4102] as [number, number], warmModules: "/opt/plow/openclaw-warm-modules.txt", prepare });

test("SIGUSR2 starts a standby beside the gateway and stops the gateway only once the standby is warm", async t => {
  const { options, errors, gateways } = fakeSupervisor(t);
  let prepared = 0;
  await startGateway(true, undefined, takeoverOptions(async () => { prepared++; }));
  const [first] = gateways();
  assert.deepEqual(first.args, ["/app/openclaw.mjs", "gateway", "--port", "4101"]);
  process.emit("SIGUSR2");
  await setImmediate();
  const standby = gateways()[1];
  assert.equal(prepared, 1, "the standby's config is written first");
  assert.deepEqual(standby.args, ["/app/openclaw.mjs", "gateway", "--port", "4102"]);
  assert.equal(options.at(-1)!.env!.OPENCLAW_GATEWAY_STANDBY, "1");
  assert.equal(options.at(-1)!.env!.OPENCLAW_GATEWAY_WARM_MODULES, "/opt/plow/openclaw-warm-modules.txt");
  assert.equal(options.at(-1)!.stdio![3], "ipc", "the standby says it is warm over IPC");
  assert.equal(options[0].env!.OPENCLAW_GATEWAY_STANDBY, undefined, "the running gateway is not a standby");
  process.emit("SIGUSR2");
  await setImmediate();
  assert.equal(gateways().length, 2, "one takeover at a time");
  assert.deepEqual(first.signals, [], "the running gateway serves while the standby warms up");
  warm(standby);
  assert.deepEqual(first.signals, ["SIGTERM"]);
  await setImmediate();
  assert.equal(errors.at(-1), "plow-boot: replaced gateway exited code=null signal=SIGTERM");
  t.mock.timers.tick(60_000);
  assert.equal(gateways().length, 2, "the replaced gateway is not restarted");
  assert.deepEqual(standby.signals, []);
  process.emit("SIGUSR2");
  await setImmediate();
  assert.deepEqual(gateways()[2].args.at(-1), "4101", "the next takeover goes back to the first port");
});

test("a standby that exits or is not warm in time leaves the running gateway serving", async t => {
  const { errors, gateways } = fakeSupervisor(t);
  await startGateway(true, undefined, takeoverOptions());
  const [first] = gateways();
  process.emit("SIGUSR2");
  await setImmediate();
  gateways()[1].emit("close", 1, null);
  assert.equal(errors.at(-1), "plow-boot: standby gateway exited code=1 signal=null");
  t.mock.timers.tick(60_000);
  assert.equal(gateways().length, 2, "a failed standby is not restarted");
  process.emit("SIGUSR2");
  await setImmediate();
  t.mock.timers.tick(180_000);
  assert.deepEqual(gateways()[2].signals, ["SIGTERM"], "a standby still cold after 3 minutes is stopped");
  await setImmediate();
  assert.deepEqual(first.signals, []);
  warm(gateways()[2]);
  assert.deepEqual(first.signals, [], "a late warm message from a stopped standby changes nothing");
});

test("a gateway that took over and then dies is restarted on its own port", async t => {
  const { gateways } = fakeSupervisor(t);
  await startGateway(true, undefined, takeoverOptions());
  process.emit("SIGUSR2");
  await setImmediate();
  warm(gateways()[1]);
  await setImmediate();
  gateways()[1].emit("close", 1, null);
  t.mock.timers.tick(1_000);
  assert.deepEqual(gateways()[2].args, ["/app/openclaw.mjs", "gateway", "--port", "4102"]);
});

test("a takeover waits out a gateway restart, and a standby warmed meanwhile replaces it", async t => {
  const { gateways } = fakeSupervisor(t);
  await startGateway(true, undefined, takeoverOptions());
  process.emit("SIGUSR2");
  await setImmediate();
  gateways()[0].emit("close", 1, null);
  warm(gateways()[1]);
  t.mock.timers.tick(60_000);
  assert.equal(gateways().length, 2, "the standby, not a restart, replaces the gateway that died");
  gateways()[1].emit("close", 1, null);
  process.emit("SIGUSR2");
  await setImmediate();
  assert.equal(gateways().length, 2, "no takeover while a restart is pending");
  t.mock.timers.tick(2_000);
  assert.deepEqual(gateways()[2].args.at(-1), "4102", "the restart, backed off after the first death, takes the standby's port");
});

test("a takeover whose config cannot be written starts no standby", async t => {
  const { errors, gateways } = fakeSupervisor(t);
  await startGateway(true, undefined, takeoverOptions(async () => { throw new Error("--prepare exited 1"); }));
  process.emit("SIGUSR2");
  await setImmediate();
  assert.equal(gateways().length, 1);
  assert.equal(errors.at(-1), "plow-boot: takeover not started: --prepare exited 1");
});

test("without a front the gateway keeps its configured port and SIGUSR2 is left alone", async t => {
  const { gateways } = fakeSupervisor(t);
  const listeners = process.listenerCount("SIGUSR2");
  await startGateway(true);
  assert.deepEqual(gateways()[0].args, ["/app/openclaw.mjs", "gateway"]);
  assert.equal(process.listenerCount("SIGUSR2"), listeners);
});

// The agent reaches its owner's machines through the latch CLI alone. Plow still hands out the Mac
// relay's URL, and boot must leave it unused.
test("with a relay URL from /me, boot adds no MCP server, no relay instructions and no bridge", async t => {
  const { children, gateways } = fakeSupervisor(t);
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    asked.push(url);
    return Response.json({ agent: { name: "Juniper" }, line: { uid: "ln_phone" }, chats: [], mcp_url: "https://relay/mcp" });
  });
  const identity = await identityFromApi("http://fixture", "test-token");
  assert.equal(renderConfig(identity, "http://fixture").mcp.servers, undefined);
  const prompt = renderPrompt("Base prompt.");
  assert.doesNotMatch(prompt, /relay|Instructions from your owner's Mac/);
  await startGateway(true);
  assert.deepEqual(asked, ["http://fixture/v1/agents/me"], "boot asks the relay nothing");
  assert.deepEqual(children, gateways(), "the gateway is the only child");
  assert.equal(children.length, 1);
});

// An agent upgraded in place keeps its VM's original environment, which has none of latch's settings.
for (const path of ["/usr/local/bin:/usr/bin", "/home/node/.local/bin:/usr/bin"]) test(`the gateway gets latch's PATH, state and update settings from boot (PATH ${path})`, async t => {
  const env = { PATH: process.env.PATH, LATCH_STATE_DIR: process.env.LATCH_STATE_DIR, LATCH_NO_UPDATE_CHECK: process.env.LATCH_NO_UPDATE_CHECK };
  process.env.PATH = path;
  delete process.env.LATCH_STATE_DIR;
  delete process.env.LATCH_NO_UPDATE_CHECK;
  t.after(() => { for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const { options } = fakeSupervisor(t);
  await startGateway(true);
  assert.equal(options[0].env!.PATH, path.startsWith("/home/node/.local/bin") ? path : `/home/node/.local/bin:${path}`);
  assert.equal(options[0].env!.LATCH_STATE_DIR, "/var/lib/plow/latch");
  assert.equal(options[0].env!.LATCH_NO_UPDATE_CHECK, "1");
});

// Boot installs the newest latch (and writes its skill) here, deciding by the kind of start.
test("beforeGateway runs before the first gateway, a restart and a standby, told which, each waiting for it", async t => {
  const { gateways } = fakeSupervisor(t);
  const seen: string[] = [];
  let release = () => {};
  const beforeGateway = (start: string) => {
    seen.push(`${start}@${gateways().length}`);
    return new Promise<void>(resolve => { release = resolve; });
  };
  const starting = startGateway(true, undefined, { ...takeoverOptions(), beforeGateway });
  await setImmediate();
  assert.equal(gateways().length, 0, "the first gateway waits for it");
  release();
  await starting;
  gateways()[0].emit("close", 1, null);
  t.mock.timers.tick(1_000);
  await setImmediate();
  assert.equal(gateways().length, 1, "a restart waits for it");
  release();
  await setImmediate();
  assert.equal(gateways().length, 2);
  process.emit("SIGUSR2");
  await setImmediate();
  assert.equal(gateways().length, 2, "a standby waits for it");
  release();
  await setImmediate();
  await setImmediate();
  assert.equal(gateways().length, 3);
  assert.deepEqual(seen, ["start@0", "restart@1", "standby@2"]);
});
