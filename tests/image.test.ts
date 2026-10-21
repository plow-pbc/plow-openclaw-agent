import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));

test("the usage collector runs on the image's native architecture", async () => {
  const binary = await readFile("/usr/local/bin/agentsview");
  const machine = new Map([["arm64", 183], ["x64", 62]]).get(process.arch);
  assert.ok(machine, `Unsupported image architecture: ${process.arch}`);
  assert.equal(binary.readUInt16LE(18), machine, "agentsview must match the native runtime");
  execFileSync("/usr/local/bin/agentsview", ["--version"]);
});

test("a texted iPhone photo (HEIC) converts to JPEG, so the model can be shown it", async () => {
  // OpenClaw reads local media only from its own roots; the state dir's workspace is one.
  process.env.OPENCLAW_STATE_DIR = await mkdtemp(`${tmpdir()}/plow-heic-`);
  const photo = `${process.env.OPENCLAW_STATE_DIR}/workspace/IMG_0413.HEIC`;
  await mkdir(`${process.env.OPENCLAW_STATE_DIR}/workspace`);
  await copyFile(new URL("./fixtures/photo.heic", import.meta.url), photo);
  const { loadWebMedia } = await import(require.resolve("openclaw/plugin-sdk/web-media"));
  const media = await loadWebMedia(photo);
  assert.equal(media.contentType, "image/jpeg");
  assert.equal(media.buffer.subarray(0, 3).toString("hex"), "ffd8ff");
});

test("ImageMagick, there for HEIC, refuses any other format a stranger could send", async () => {
  const dir = await mkdtemp(`${tmpdir()}/plow-magick-`);
  await writeFile(`${dir}/image.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
  assert.throws(() => execFileSync("convert", [`${dir}/image.svg`, `${dir}/out.png`], { stdio: "pipe" }), /not authorized/);
});
