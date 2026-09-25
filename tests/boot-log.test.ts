import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("boot lines reach the console and a bounded state log", async t => {
  const state = await mkdtemp(join(tmpdir(), "plow-boot-log-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const moduleUrl = new URL("../boot/log.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(moduleUrl)}).then(({ installBootLog }) => {
    installBootLog();
    console.log("plow-boot: ready");
    console.error("plow-boot: parked");
    console.log("x".repeat(150000));
    console.log("y".repeat(150000));
  })`], { env: { ...process.env, OPENCLAW_STATE_DIR: state }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /plow-boot: ready/);
  assert.match(child.stderr, /plow-boot: parked/);
  const previous = await readFile(join(state, "boot.log.1"), "utf8");
  const current = await readFile(join(state, "boot.log"), "utf8");
  assert.match(previous, /plow-boot: ready/);
  assert.match(previous, /plow-boot: parked/);
  assert.ok(current.includes("y".repeat(150000)));
  assert.ok((await stat(join(state, "boot.log.1"))).size <= 256 * 1024);
  assert.ok((await stat(join(state, "boot.log"))).size <= 256 * 1024);
});

test("gateway and bridge output reaches the console and boot log", async t => {
  const state = await mkdtemp(join(tmpdir(), "plow-child-log-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const logUrl = new URL("../boot/log.ts", import.meta.url).href;
  const processUrl = new URL("../boot/process.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { syncBuiltinESMExports } from "node:module";
    import { PassThrough } from "node:stream";
    const children = [];
    childProcess.spawn = (_command, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill() { this.emit("close", null, "SIGTERM"); },
      });
      children.push(child);
      if (args[0].endsWith("mcp-bridge.js")) queueMicrotask(() => child.emit("message", "ready"));
      return child;
    };
    syncBuiltinESMExports();
    const { installBootLog } = await import(${JSON.stringify(logUrl)});
    const { startGateway } = await import(${JSON.stringify(processUrl)});
    const writeLog = installBootLog();
    await startGateway(false, "https://relay/mcp", writeLog);
    children[0].stdout.write("bridge started\\n");
    children[0].stderr.write("bridge warning\\n");
    children[1].stdout.write("gateway started\\n");
    children[1].stderr.write("gateway failure\\n");
    children[1].emit("close", 0, null);
  `], { env: { ...process.env, OPENCLAW_STATE_DIR: state }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /bridge started/);
  assert.match(child.stdout, /gateway started/);
  assert.match(child.stderr, /bridge warning/);
  assert.match(child.stderr, /gateway failure/);
  const log = await readFile(join(state, "boot.log"), "utf8");
  for (const line of ["bridge started", "bridge warning", "gateway started", "gateway failure"]) assert.match(log, new RegExp(line));
});
