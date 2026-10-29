import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

// latch, the command-line tool the agent reaches its owner's machines with, follows its newest
// release: the image build installs the one out then, and every boot installs the one out now,
// with latch's own published installer, as a client only (it asks hosts and never is one). Its
// skill is written from the binary installed, so the two always match.
export const INSTALLER = "https://releases.plow.co/latch-cli/install.sh";
export const BIN_DIR = "/home/node/.local/bin";
export const SKILL = "/opt/plow/skills/latch/SKILL.md";

export type LatchInstall = { installer?: string; binDir?: string; skill?: string; env?: NodeJS.ProcessEnv };

// Installs the newest latch into binDir and writes its skill. Throws when either fails; a failed
// install leaves the latch there, and a failed skill write leaves the skill there.
export async function installLatch({ installer = INSTALLER, binDir = BIN_DIR, skill = SKILL, env = process.env }: LatchInstall = {}): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "plow-latch-"));
  try {
    // Its own state folder, never the agent's login: the installer only marks it client-only.
    await run("sh", ["-c", 'curl -fsSLO "$1" && sh install.sh --client-only --non-interactive --bin-dir "$2" --state-dir "$3"', "sh", installer, binDir, join(work, "state")],
      { cwd: work, env, timeout: 300_000 });
    const latch = join(binDir, "latch");
    const { stdout } = await run(latch, ["skill"], { env, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(`${skill}.tmp`, stdout);
    await rename(`${skill}.tmp`, skill);
    return JSON.parse((await run(latch, ["--version"], { env })).stdout).version;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// The image build runs this file, so it installs latch the way boot does; it fails the build when
// it cannot.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(`latch ${await installLatch()}`);
}
