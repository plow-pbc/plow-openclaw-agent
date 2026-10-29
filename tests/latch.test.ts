import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { installLatch } from "../boot/latch.ts";

// A latch that answers --version and skill as build `build`.
const fakeLatch = (build: number) => `#!/bin/sh
case "$1" in
  --version) printf '{"version":"0.1.0 (${build})"}\\n' ;;
  skill) printf 'skill of build ${build}\\n' ;;
esac
`;

// A machine with build 149 installed and its skill, and a curl that serves the installer, or fails.
async function machine(t: TestContext, installer: "newer" | "unreachable" | "refused") {
  const root = await mkdtemp(join(tmpdir(), "plow-latch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [bin, tools] = [join(root, "bin"), join(root, "tools")];
  await mkdir(bin);
  await mkdir(tools);
  await writeFile(join(bin, "latch"), fakeLatch(149), { mode: 0o755 });
  const skill = join(root, "SKILL.md");
  await writeFile(skill, "skill of build 149\n");
  // install.sh puts build 150 into --bin-dir; curl writes it where -O would.
  await writeFile(join(root, "install.sh"), installer === "refused" ? `#!/bin/sh
echo "latch.tar.gz: FAILED" >&2
echo "sha256sum: WARNING: 1 computed checksum did NOT match" >&2
exit 1
` : `#!/bin/sh
set -eu
[ "$1" = --client-only ] && [ "$2" = --non-interactive ] && [ "$3" = --bin-dir ] && [ "$5" = --state-dir ]
cat > "$4/latch.tmp" <<'EOF'
${fakeLatch(150)}EOF
chmod +x "$4/latch.tmp" && mv "$4/latch.tmp" "$4/latch"
`);
  await writeFile(join(tools, "curl"), installer !== "unreachable"
    ? `#!/bin/sh\n[ "$1" = -fsSLO ] && [ "$2" = https://releases.example/install.sh ] && cp "${join(root, "install.sh")}" install.sh\n`
    : `#!/bin/sh\necho "curl: (6) Could not resolve host" >&2\nexit 6\n`);
  await chmod(join(tools, "curl"), 0o755);
  const options = { installer: "https://releases.example/install.sh", binDir: bin, skill, env: { ...process.env, PATH: `${tools}:${process.env.PATH}` } };
  return { bin, skill, options };
}

test("a newer latch is installed and its skill written from it", async t => {
  const { bin, skill, options } = await machine(t, "newer");
  assert.equal(await installLatch(options), "0.1.0 (150)");
  assert.match(await readFile(join(bin, "latch"), "utf8"), /0\.1\.0 \(150\)/);
  assert.equal(await readFile(skill, "utf8"), "skill of build 150\n");
});

for (const [failure, message] of [["unreachable", /Could not resolve host/], ["refused", /checksum did NOT match/]] as const) test(`when the install fails (${failure}), the installed latch and its skill stay`, async t => {
  const { bin, skill, options } = await machine(t, failure);
  await assert.rejects(installLatch(options), message);
  assert.match(await readFile(join(bin, "latch"), "utf8"), /0\.1\.0 \(149\)/);
  assert.equal(await readFile(skill, "utf8"), "skill of build 149\n");
});
