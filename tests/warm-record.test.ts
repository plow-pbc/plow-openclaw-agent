import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("the recorder lists only modules first loaded after the gateway's lock point", async t => {
  // Real path: module URLs are resolved through symlinks such as macOS's /var.
  const root = await realpath(await mkdtemp(join(tmpdir(), "plow-warm-record-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["early", "late", "both"]) await writeFile(join(root, `${name}.mjs`), `export const name = "${name}";\n`);
  await writeFile(join(root, "main.mjs"), [
    `await import("./early.mjs");`,
    `await import("./both.mjs");`,
    `globalThis[Symbol.for("plow.gateway.lock-point")] = true;`,
    `await import("./late.mjs");`,
    `await import("./both.mjs");`,
    `await import("./early.mjs?cache-buster");`,
  ].join("\n"));
  const list = join(root, "warm.txt");
  execFileSync(process.execPath, ["--import", new URL("../boot/warm-record.ts", import.meta.url).href, join(root, "main.mjs")], {
    env: { ...process.env, OPENCLAW_GATEWAY_WARM_RECORD: list },
  });
  assert.deepEqual((await readFile(list, "utf8")).split("\n").filter(Boolean), [pathToFileURL(join(root, "late.mjs")).href]);
});
