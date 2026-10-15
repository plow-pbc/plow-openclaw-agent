import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { startGateway } from "../boot/process.ts";

for (const ending of ["bridge", "signal", "startup-failure", "restart-shutdown"] as const) test(`supervisor handles child exit: ${ending}`, async t => {
  const previousCode = process.exitCode;
  const listeners = process.listenerCount("SIGTERM");
  const children: (EventEmitter & { kill: (signal: string) => void; signals: string[] })[] = [];
  const options: SpawnOptions[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(childProcess, "spawn", (_command: string, args: string[], opts: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { signals: [] as string[], kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null, signal)); } });
    children.push(child); options.push(opts);
    if (args[0].endsWith("mcp-bridge.js")) queueMicrotask(() => ending === "startup-failure" && children.length === 1 ? (child.emit("error", new Error("spawn failed")), child.emit("close", -2, null)) : child.emit("message", "ready"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { process.emit("SIGTERM"); t.mock.restoreAll(); syncBuiltinESMExports(); process.exitCode = previousCode; });
  const bridgeToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
  process.env.PLOW_MCP_BRIDGE_TOKEN = "supervisor-fixture-secret";
  t.after(() => {
    if (bridgeToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN;
    else process.env.PLOW_MCP_BRIDGE_TOKEN = bridgeToken;
  });
  const starting = startGateway(true, "https://relay/mcp");
  assert.equal(children.length, 1, "gateway waits for bridge readiness");
  assert.equal(await starting, children[1]);
  assert.deepEqual(Object.keys(options[0].env!).sort(), ["PLOW_AGENT_TOKEN", "PLOW_MCP_BRIDGE_TOKEN", "PLOW_MCP_URL"]);
  assert.equal(options[0].env!.PLOW_MCP_BRIDGE_TOKEN, "supervisor-fixture-secret");
  if (ending === "bridge" || ending === "startup-failure") {
    if (ending === "bridge") children[0].emit("close", null, "SIGKILL");
    assert.deepEqual(children[1].signals, [], "bridge death must not stop the gateway");
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(options[2].env!.PLOW_MCP_BRIDGE_TOKEN, "supervisor-fixture-secret");
    assert.equal(children.length, 3, "boot restarts the bridge");
    assert.deepEqual(children[1].signals, [], "gateway survives the restart");
    process.emit("SIGTERM");
    await setImmediate();
    assert.deepEqual(children[2].signals, ["SIGTERM"]);
  } else if (ending === "restart-shutdown") {
    children[0].emit("close", 1, null);
    process.emit("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(children.length, 2, "shutdown cancels a pending bridge restart");
    assert.deepEqual(children[1].signals, ["SIGTERM"]);
  } else {
    process.emit("SIGTERM");
    await setImmediate();
    assert.ok(children[1].signals.includes("SIGTERM"));
  }
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(process.exitCode, previousCode);
});

type FakeChild = EventEmitter & { args: string[]; kill: (signal: string) => void; signals: string[] };

function fakeSupervisor(t: TestContext) {
  const listeners = process.listenerCount("SIGTERM");
  const children: FakeChild[] = [];
  const errors: string[] = [];
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(console, "error", (line: unknown) => { errors.push(String(line)); });
  t.mock.method(childProcess, "spawn", (_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { args, signals: [] as string[], kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null, signal)); } });
    children.push(child);
    if (args[0].endsWith("mcp-bridge.js")) queueMicrotask(() => child.emit("message", "ready"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { process.emit("SIGTERM"); t.mock.timers.reset(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const gateways = () => children.filter(child => child.args[0] === "/app/openclaw.mjs");
  return { children, errors, gateways, listeners };
}

for (const [code, signal] of [[0, null], [1, null], [null, "SIGKILL"]] as const) test(`supervisor restarts a gateway that exits code=${code} signal=${signal}`, async t => {
  const { children, errors, gateways } = fakeSupervisor(t);
  await startGateway(true, "https://relay/mcp");
  gateways()[0].emit("close", code, signal);
  assert.equal(errors.at(-1), `plow-boot: gateway exited code=${code} signal=${signal}; restarting in 1s`);
  t.mock.timers.tick(999);
  assert.equal(gateways().length, 1);
  t.mock.timers.tick(1);
  assert.equal(gateways().length, 2, "the gateway comes back");
  assert.deepEqual(children[0].signals, [], "the bridge keeps running");
});

test("supervisor backs off gateway restarts to a minute, and resets after a healthy run", async t => {
  const { errors, gateways } = fakeSupervisor(t);
  await startGateway(true, "https://relay/mcp");
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
  await startGateway(true, "https://relay/mcp");
  process.emit("SIGTERM");
  await setImmediate();
  assert.deepEqual(children.map(child => child.signals), [["SIGTERM"], ["SIGTERM"]]);
  assert.deepEqual(errors, ["plow-boot: gateway exited code=null signal=SIGTERM"]);
  t.mock.timers.tick(60_000);
  assert.equal(gateways().length, 1);
  assert.equal(process.listenerCount("SIGTERM"), listeners);
});
