import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export type LatchInstall = { installer?: string; binDir?: string; skill?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };

// Installs the newest latch into binDir and writes its skill. Throws when either fails; a failed
// install leaves the latch there, and a failed skill write leaves the skill there. An install
// still running after timeoutMs (a minute, for a boot) is stopped, installer and all.
export async function installLatch({ installer = INSTALLER, binDir = BIN_DIR, skill = SKILL, env = process.env, timeoutMs = 60_000 }: LatchInstall = {}): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "plow-latch-"));
  try {
    // Its own state folder, never the agent's login: the installer only marks it client-only.
    await install(['curl -fsSLO "$1" && sh install.sh --client-only --non-interactive --bin-dir "$2" --state-dir "$3"', "sh", installer, binDir, join(work, "state")],
      work, env, timeoutMs);
    const latch = join(binDir, "latch");
    const { stdout } = await run(latch, ["skill"], { env, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(`${skill}.tmp`, stdout);
    await rename(`${skill}.tmp`, skill);
    return JSON.parse((await run(latch, ["--version"], { env })).stdout).version;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// When boot installs latch before a gateway starts: always before the first one and before an
// upgrade's standby, and before a restart only when the image changed since the last install, as
// it has after an in-place upgrade whose cutover restarts the gateway. One install runs at a time,
// since two would share the bin folder and the skill's temporary file; a caller arriving while one
// runs waits for it. It never throws: a failed install is logged, and the gateway starts on the
// latch it has.
export type GatewayStart = "start" | "restart" | "standby";
export function latchRefresher({ install = () => installLatch(), revision = imageRevision }: { install?: () => Promise<string>; revision?: () => Promise<string> } = {}) {
  let inFlight: Promise<void> | undefined;
  let installedFor: string | undefined;
  return (start: GatewayStart): Promise<void> => inFlight ??= (async () => {
    const image = await revision();
    if (start === "restart" && image === installedFor) return;
    // Recorded whether or not the install works, so a gateway that keeps crashing is not held up
    // by an install on every restart.
    installedFor = image;
    try {
      console.log(`plow-boot: latch ${await install()}`);
    } catch (error) {
      console.warn(`plow-boot: latch not updated; keeping the installed one: ${error instanceof Error ? error.message : String(error)}`);
    }
  })().finally(() => { inFlight = undefined; });
}

// The commit the image was built from, written by its build into the image's own files, so an
// in-place upgrade changes it while the VM's environment stays as it was created.
async function imageRevision(): Promise<string> {
  return (await readFile("/opt/plow/revision", "utf8").catch(() => "")).trim();
}

// The installer in a process group of its own, so a timeout stops curl and install-binary.sh too.
function install(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", ...args], { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      reject(new Error(`the latch installer did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`the latch installer exited ${code}: ${stderr.trim()}`));
    });
  });
}

// Earlier latch state folders, from before the agent's latch lived in the state volume
// (LATCH_STATE_DIR): each holds a key of its own, and two keys for one agent make its peer flip
// between them. Only these exact folders are removed, and only once the state volume's folder has
// a login and key of its own, so the agent is never left with none.
export const STATE_DIR = "/var/lib/plow/latch";
export async function removeLegacyLatchState(folders: string[], stateDir = STATE_DIR): Promise<void> {
  try {
    await Promise.all(["config.json", "key"].map(name => lstat(join(stateDir, name))));
  } catch {
    return;
  }
  for (const folder of folders) {
    try {
      await lstat(folder);
    } catch {
      continue;
    }
    try {
      await rm(folder, { recursive: true, force: true });
      console.log(`plow-boot: removed the earlier latch state folder ${folder}`);
    } catch (error) {
      console.warn(`plow-boot: could not remove the earlier latch state folder ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// The image build runs this file, so it installs latch the way boot does; it fails the build when
// it cannot.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(`latch ${await installLatch()}`);
}
