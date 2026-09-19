import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

for (const mode of ["json", "sse", "failure", "redirect"] as const) test(`stdio bridge forwards MCP: ${mode}`, async t => {
  const received: { rpc: { method: string }; headers: Record<string, unknown> }[] = [];
  let redirected = false;
  const server = createServer(async (request, response) => {
    if (request.url === "/destination") redirected = true;
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    received.push({ rpc, headers: request.headers });
    if (mode === "failure") { response.writeHead(503).end("secret upstream details"); return; }
    if (mode === "redirect") { response.writeHead(307, { Location: "/destination" }).end(); return; }
    if (!("id" in rpc)) { response.writeHead(202).end(); return; }
    const reply = { jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { content: [{ type: "text", text: "BRIDGE-SKILLS-OK" }] } };
    response.writeHead(200, { "Content-Type": mode === "sse" ? "text/event-stream" : "application/json", "Mcp-Session-Id": "fixture-session" });
    response.end(mode === "sse" ? `: heartbeat\r\nevent: message\r\ndata: ${JSON.stringify(reply, null, 2).replaceAll("\n", "\r\ndata: ")}\r\n\r\n` : JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [new URL("../boot/mcp-bridge.ts", import.meta.url).pathname], {
    env: { ...process.env, PLOW_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, PLOW_AGENT_TOKEN: "fixture-token" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "", errors = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { errors += data; });
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "plow_list_skills", arguments: {} } },
  ];
  child.stdin.end(requests.map(request => JSON.stringify(request)).join("\n") + "\n");
  const [code] = await once(child, "close");
  assert.equal(code, 0, errors);
  assert.deepEqual(received.map(entry => entry.rpc), requests);
  assert.ok(received.every(entry => entry.headers.authorization === "Bearer fixture-token"));
  const replies = output.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [1, 2]);
  if (mode === "json" || mode === "sse") {
    assert.equal(errors, "");
    assert.equal(received[1].headers["mcp-session-id"], "fixture-session");
    assert.equal(received[2].headers["mcp-protocol-version"], "2025-06-18");
    assert.deepEqual(replies[1].result.content, [{ type: "text", text: "BRIDGE-SKILLS-OK" }]);
  } else {
    assert.ok(replies.every(reply => reply.error.code === -32603));
    assert.ok(!output.includes("secret upstream details"));
    assert.equal(redirected, false);
  }
});
