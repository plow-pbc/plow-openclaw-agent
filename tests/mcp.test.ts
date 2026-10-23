import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const mode of ["json", "sse", "failure", "expired", "redirect"] as const) test(`HTTP bridge forwards MCP without replay: ${mode}`, async t => {
  const received: { method: string; session?: string; protocol?: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    received.push({ method: rpc.method, session: request.headers["mcp-session-id"] as string, protocol: request.headers["mcp-protocol-version"] as string });
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (mode === "failure" || mode === "expired") { response.writeHead(mode === "failure" ? 503 : 404).end("upstream error"); return; }
    if (mode === "redirect") { response.writeHead(307, { Location: "/destination" }).end(); return; }
    if (!("id" in rpc)) { response.writeHead(202).end(); return; }
    const reply = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "BRIDGE-OK" }] } });
    response.writeHead(200, { "Content-Type": mode === "sse" ? "text/event-stream" : "application/json", "Mcp-Session-Id": request.headers["mcp-session-id"]! });
    response.end(mode === "sse" ? `event: message\ndata: ${reply}\n\n` : reply);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [new URL("../boot/mcp-bridge.ts", import.meta.url).pathname], {
    env: { PLOW_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, PLOW_AGENT_TOKEN: "fixture-token", PLOW_MCP_BRIDGE_TOKEN: "bridge-secret" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(async () => { const closed = once(child, "close"); child.kill(); await closed; });
  await once(child, "message");
  for (const authorization of [undefined, "Bearer wrong", "Bearer fixture-token"]) {
    const response = await fetch("http://127.0.0.1:18790/mcp", {
      method: "POST", headers: { "Mcp-Session-Id": "unauthorized", ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    });
    assert.equal(response.status, 401);
    await response.text();
    assert.equal(received.length, 0, "unauthorized requests never reach the relay");
  }
  const responses = await Promise.all(["session-A", "session-B"].map(session => fetch("http://127.0.0.1:18790/mcp", {
    method: "POST", headers: { Authorization: "Bearer bridge-secret", "Content-Type": "application/json", "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: session, method: "tools/call", params: { name: "write_file" } }),
  })));
  assert.equal(received.length, 2);
  assert.deepEqual(received.map(r => r.session).sort(), ["session-A", "session-B"]);
  assert.ok(received.every(r => r.protocol === "2025-06-18"));
  for (const [i, response] of responses.entries()) {
    assert.equal(response.status, mode === "failure" ? 503 : mode === "expired" ? 404 : mode === "redirect" ? 502 : 200);
    if (mode === "json" || mode === "sse") {
      assert.equal(response.headers.get("mcp-session-id"), i ? "session-B" : "session-A");
      assert.ok((await response.text()).includes("BRIDGE-OK"));
    } else await response.text();
  }
  if (mode === "json" || mode === "sse") {
    const response = await fetch("http://127.0.0.1:18790/mcp", { method: "POST", headers: { Authorization: "Bearer bridge-secret" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  }
});

for (const mode of ["stream", "slow-tool"] as const) test(`HTTP bridge preserves long-lived MCP: ${mode}`, { timeout: 75_000 }, async t => {
  let calls = 0;
  let timer: NodeJS.Timeout | undefined;
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (mode === "stream") {
      assert.equal(request.method, "GET");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
      response.on("close", () => server.emit("upstream-closed"));
    } else {
      timer = setTimeout(() => response.writeHead(200, { "Content-Type": "application/json" }).end('{"result":"completed-once"}'), 61_000);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [new URL("../boot/mcp-bridge.ts", import.meta.url).pathname], {
    env: { PLOW_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, PLOW_AGENT_TOKEN: "fixture-token", PLOW_MCP_BRIDGE_TOKEN: "bridge-secret" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(async () => {
    clearTimeout(timer);
    const closed = once(child, "close"); child.kill(); await closed;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(child, "message");
  const response = await fetch("http://127.0.0.1:18790/mcp", {
    method: mode === "stream" ? "GET" : "POST",
    headers: { Authorization: "Bearer bridge-secret", Accept: "application/json, text/event-stream" },
    ...(mode === "stream" ? {} : { body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' }),
    signal: AbortSignal.timeout(mode === "stream" ? 2_000 : 70_000),
  });
  assert.equal(response.status, 200);
  if (mode === "stream") {
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /tools\/list_changed/);
    const upstreamClosed = once(server, "upstream-closed", { signal: AbortSignal.timeout(2_000) });
    await reader.cancel();
    await upstreamClosed;
  } else assert.equal(await response.text(), '{"result":"completed-once"}');
  assert.equal(calls, 1, "no replay of the upstream action");
});

test("HTTP bridge saves a tool's screenshot and file where the agent can text them (#116)", async t => {
  const files = await mkdtemp(join(tmpdir(), "plow-mcp-files-"));
  t.after(() => rm(files, { recursive: true, force: true }));
  // A full folder: the oldest files make room for the new ones.
  for (let i = 0; i < 100; i++) await mkdir(join(files, `${String(1_000_000 + i).padStart(13, "0")}-0`));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const pdf = Buffer.from("%PDF-1.4 not text \xff\xfe", "latin1");
  const text = '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"no files here"}]}}';
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    if (rpc.id === 2) { response.end(text); return; }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [
      { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
      { type: "text", text: '{"title":"Registration received"}' },
      { type: "resource", resource: { uri: "file:///Users/owner/Plow/alder%20test.pdf", blob: pdf.toString("base64") } },
    ] } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [new URL("../boot/mcp-bridge.ts", import.meta.url).pathname], {
    env: { PLOW_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, PLOW_AGENT_TOKEN: "fixture-token", PLOW_MCP_BRIDGE_TOKEN: "bridge-secret", PLOW_MCP_FILES_DIR: files },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(async () => { const closed = once(child, "close"); child.kill(); await closed; });
  await once(child, "message");
  const call = (id: number) => fetch("http://127.0.0.1:18790/mcp", {
    method: "POST", headers: { Authorization: "Bearer bridge-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "plow_browser" } }),
  });
  const { result } = await (await call(1)).json();
  const [image, saved, title, savedFile] = result.content;
  assert.deepEqual(image, { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }, "a model that can see keeps the image");
  assert.deepEqual(title, { type: "text", text: '{"title":"Registration received"}' });
  const imagePath = saved.text.match(/^This image is saved on your machine\. To text it, attach this path: (\S+\/\d+-1\/screenshot\.jpg)$/)?.[1];
  const filePath = savedFile.text.match(/^file:\/\/\/Users\/owner\/Plow\/alder%20test\.pdf is saved on your machine\. To text it, attach this path: (\S+\/\d+-2\/alder_test\.pdf)$/)?.[1];
  assert.ok(imagePath?.startsWith(files + "/") && filePath?.startsWith(files + "/"), JSON.stringify([saved, savedFile]));
  assert.equal(result.content.length, 4, "the file's bytes reach the agent as the saved file, not in the result");
  assert.deepEqual(await readFile(imagePath), jpeg);
  assert.deepEqual(await readFile(filePath), pdf);
  const kept = await readdir(files);
  assert.equal(kept.length, 100);
  assert.ok(!kept.includes("0000001000000-0") && !kept.includes("0000001000001-0") && kept.includes("0000001000002-0"), "the two oldest went");
  assert.equal(await (await call(2)).text(), text, "a result with no image or file passes unchanged");
});
