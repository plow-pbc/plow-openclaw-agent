import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { startGateway } from "../boot/process.ts";

type FakeChild = EventEmitter & { args: string[]; kill: (signal: string) => void; signals: string[] };

function fakeSupervisor(t: TestContext, { bridgeFailsToStart = false } = {}) {
  const listeners = process.listenerCount("SIGTERM");
  const previousCode = process.exitCode;
  const bridgeToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
  process.env.PLOW_MCP_BRIDGE_TOKEN = "supervisor-fixture-secret";
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
    if (args[0].endsWith("mcp-bridge.js")) queueMicrotask(() => bridgeFailsToStart && children.length === 1 ? (child.emit("error", new Error("spawn failed")), child.emit("close", -2, null)) : child.emit("message", "ready"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    process.emit("SIGTERM");
    t.mock.timers.reset(); t.mock.restoreAll(); syncBuiltinESMExports();
    process.exitCode = previousCode;
    process.report.reportOnSignal = reportOnSignal;
    if (bridgeToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN;
    else process.env.PLOW_MCP_BRIDGE_TOKEN = bridgeToken;
  });
  const gateways = () => children.filter(child => child.args[0] === "/app/openclaw.mjs");
  return { children, options, errors, gateways, listeners, previousCode };
}

for (const ending of ["bridge", "signal", "startup-failure", "restart-shutdown"] as const) test(`supervisor handles child exit: ${ending}`, async t => {
  const { children, options, listeners, previousCode } = fakeSupervisor(t, { bridgeFailsToStart: ending === "startup-failure" });
  const starting = startGateway(true, "https://relay/mcp");
  assert.equal(children.length, 1, "gateway waits for bridge readiness");
  assert.equal(await starting, children[1]);
  assert.deepEqual(Object.keys(options[0].env!).sort(), ["PLOW_AGENT_TOKEN", "PLOW_MCP_BRIDGE_TOKEN", "PLOW_MCP_URL"]);
  assert.equal(options[0].env!.PLOW_MCP_BRIDGE_TOKEN, "supervisor-fixture-secret");
  if (ending === "bridge" || ending === "startup-failure") {
    if (ending === "bridge") children[0].emit("close", null, "SIGKILL");
    assert.deepEqual(children[1].signals, [], "bridge death must not stop the gateway");
    t.mock.timers.tick(1_000);
    assert.equal(options[2].env!.PLOW_MCP_BRIDGE_TOKEN, "supervisor-fixture-secret");
    assert.equal(children.length, 3, "boot restarts the bridge");
    assert.deepEqual(children[1].signals, [], "gateway survives the restart");
    process.emit("SIGTERM");
    await setImmediate();
    assert.deepEqual(children[2].signals, ["SIGTERM"]);
  } else if (ending === "restart-shutdown") {
    children[0].emit("close", 1, null);
    process.emit("SIGTERM");
    t.mock.timers.tick(1_000);
    await setImmediate();
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

const warm = (child: FakeChild) => child.emit("message", "warm");
const takeoverOptions = (prepare = async () => {}) => ({ frontPort: 0, ports: [4101, 4102] as [number, number], warmModules: "/opt/plow/openclaw-warm-modules.txt", prepare });

test("SIGUSR2 starts a standby beside the gateway and stops the gateway only once the standby is warm", async t => {
  const { options, errors, gateways } = fakeSupervisor(t);
  let prepared = 0;
  await startGateway(true, undefined, undefined, takeoverOptions(async () => { prepared++; }));
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
  await startGateway(true, undefined, undefined, takeoverOptions());
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
  await startGateway(true, undefined, undefined, takeoverOptions());
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
  await startGateway(true, undefined, undefined, takeoverOptions());
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
  await startGateway(true, undefined, undefined, takeoverOptions(async () => { throw new Error("--prepare exited 1"); }));
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
