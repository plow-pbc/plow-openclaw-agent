import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { joinBuzz, loadOrCreateKey } from "../plugin/buzz-identity.ts";
import { tagFor } from "./buzz-fixture.ts";

/** The wrapper installed as the image installs it (a symlink on PATH), in front of a buzz CLI that prints its environment and argv. */
async function install(t: TestContext) {
  const root = await mkdtemp(`${tmpdir()}/buzz-wrapper-`);
  t.after(() => rm(root, { recursive: true }));
  await mkdir(`${root}/opt/bin`, { recursive: true });
  await mkdir(`${root}/opt/libexec`);
  await mkdir(`${root}/path`);
  await copyFile(new URL("../bin/buzz", import.meta.url), `${root}/opt/bin/buzz`);
  await writeFile(`${root}/opt/libexec/buzz`, `#!/bin/sh\necho "$BUZZ_PRIVATE_KEY|$BUZZ_AUTH_TAG|$BUZZ_RELAY_URL|$*"\n`, { mode: 0o755 });
  await symlink(`${root}/opt/bin/buzz`, `${root}/path/buzz`);
  const run = (...args: string[]) => spawnSync(`${root}/path/buzz`, args, { encoding: "utf8", env: { PATH: process.env.PATH, OPENCLAW_STATE_DIR: `${root}/state` } });
  return { root, run };
}

test("the buzz wrapper runs the CLI as this agent with the cached attestation, the key only in its environment", async t => {
  const { root, run } = await install(t);
  const dir = `${root}/state/buzz`;
  const key = await loadOrCreateKey(dir);
  await joinBuzz({ dir, key, provider: "https://provider.test", enroll: { name: "n", harness: "h", model: "m" }, notifyOwner: async () => {},
    fetch: (async () => Response.json({ tag: tagFor(0), expires_at: 2_000_000_000 })) as unknown as typeof fetch });
  await writeFile(`${dir}/relay-url`, "https://relay.test\n");
  const r = run("messages", "send", "hello");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${key.sk}|${JSON.stringify(tagFor(0))}|https://relay.test|messages send hello`);
});

test("the wrapper refuses clearly before the channel has created a key", async t => {
  const { run } = await install(t);
  const r = run("messages", "list");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not_ready/);
});
