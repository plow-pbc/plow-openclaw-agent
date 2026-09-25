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
