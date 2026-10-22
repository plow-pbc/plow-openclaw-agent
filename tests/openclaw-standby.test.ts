import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { patchOpenClaw } from "../patches/openclaw-standby.ts";

const MARK = "/* plow-standby */";
// The pinned OpenClaw this repo installs (the image patches its own copy at /app).
const source = new URL("../node_modules/openclaw/dist/", import.meta.url).pathname;
const targets = /^(doctor-startup-migration-refusal|startup-config-preflight|gateway-lock|run)-.*\.mjs$/;

async function copyOfTargets(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "plow-standby-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  for (const name of (await readdir(source)).filter(name => targets.test(name))) await copyFile(join(source, name), join(root, "dist", name));
  return root;
}
const patchedFiles = async (root: string) => {
  const files: Record<string, string> = {};
  for (const name of await readdir(join(root, "dist"))) {
    const text = await readFile(join(root, "dist", name), "utf8");
    if (text.includes(MARK)) files[name] = text;
  }
  return files;
};

test("the standby patch edits each OpenClaw site once and the result still parses", async t => {
  const root = await copyOfTargets(t);
  await patchOpenClaw(root);
  const files = await patchedFiles(root);
  assert.equal(Object.keys(files).length, 5);
  for (const prefix of ["doctor-startup-migration-refusal-", "startup-config-preflight-", "gateway-lock-", "run-", "plow-standby.mjs"]) {
    assert.equal(Object.keys(files).filter(name => name.startsWith(prefix)).length, 1, prefix);
  }
  for (const [name, text] of Object.entries(files)) {
    assert.equal(text.split(MARK).length - 1, 1, `${name} carries one edit`);
    execFileSync(process.execPath, ["--check", join(root, "dist", name)]);
  }
  const helper = files["plow-standby.mjs"];
  const lockModule = helper.match(/import\("\.\/(gateway-lock-[^"]+\.mjs)"\)/)![1];
  assert.ok(existsSync(join(root, "dist", lockModule)), "the helper imports the gateway lock module the refusal uses");
  const before = JSON.stringify(await patchedFiles(root));
  await patchOpenClaw(root);
  assert.equal(JSON.stringify(await patchedFiles(root)), before, "patching again changes nothing");
});

test("the standby patch fails the build when OpenClaw moved the code it edits", async t => {
  const root = await copyOfTargets(t);
  for (const name of (await readdir(join(root, "dist"))).filter(name => name.startsWith("run-"))) {
    const text = await readFile(join(root, "dist", name), "utf8");
    await writeFile(join(root, "dist", name), text.replaceAll("let lock = await acquireGatewayLock({", "let lock = await acquireGatewayLockSomewhereElse({"));
  }
  await assert.rejects(patchOpenClaw(root), /openclaw-standby: expected exactly one \/\^run-/);
});

// The image's OpenClaw, which the CI tests run inside.
const image = existsSync("/app/dist") && existsSync("/opt/plow/openclaw-warm-modules.txt");
test("the image runs a patched OpenClaw with a recorded preload", { skip: !image && "not in the image" }, async () => {
  assert.ok(existsSync("/app/dist/plow-standby.mjs"));
  const urls = (await readFile("/opt/plow/openclaw-warm-modules.txt", "utf8")).split("\n").filter(Boolean);
  assert.ok(urls.length > 100, `${urls.length} modules recorded`);
  for (const url of urls) assert.ok(existsSync(new URL(url)), `${url} exists`);
});
