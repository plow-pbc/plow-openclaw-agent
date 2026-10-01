import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the usage collector runs on the image's native architecture", async () => {
  const binary = await readFile("/usr/local/bin/agentsview");
  const machine = new Map([["arm64", 183], ["x64", 62]]).get(process.arch);
  assert.ok(machine, `Unsupported image architecture: ${process.arch}`);
  assert.equal(binary.readUInt16LE(18), machine, "agentsview must match the native runtime");
  execFileSync("/usr/local/bin/agentsview", ["--version"]);
});
