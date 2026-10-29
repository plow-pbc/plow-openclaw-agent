import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { startAgentIndex } from "./agent-index.js";
import { renderConfig, syncConfig } from "./config.js";
import { identityFromApi } from "./identity.js";
import { installBootLog } from "./log.js";
import { renderPrompt } from "./prompt.js";
import { startGateway } from "./process.js";

// --prepare writes the config and prompt for a standby gateway (process.ts takeover) with this
// image's code, and keeps the running supervisor's gateway password.
const prepareOnly = process.argv.includes("--prepare");
// SIGUSR2 would end the process until the supervisor takes it, and nothing would restart it.
const early = () => console.error("plow-boot: SIGUSR2 before the gateway started; ignored");
process.on("SIGUSR2", early);

try {
  const writeLog = installBootLog();
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!prepareOnly) {
    process.env.OPENCLAW_GATEWAY_PASSWORD = randomBytes(32).toString("hex");
  }
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  const config = renderConfig(identity, base);
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  if (!prepareOnly) {
    await writeFile("/var/lib/plow/gateway-password", process.env.OPENCLAW_GATEWAY_PASSWORD + "\n", { mode: 0o600 });
    await chmod("/var/lib/plow/gateway-password", 0o600);
  }
  for (const name of ["BOOTSTRAP.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await rm(`/var/lib/plow/workspace/${name}`, { force: true });
  }
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", renderPrompt(prompt, config.channels.plow.threadTrust, identity.agent?.web_url));
  await syncConfig(config, "/var/lib/plow/openclaw.json", "/etc/plow/openclaw");
  if (prepareOnly) {
    console.log(`plow-boot: standby config written for ${identity.line.uid}`);
    process.exit(0);
  }
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  startAgentIndex(300_000, writeLog);
  await startGateway(false, writeLog, {
    frontPort: 3000,
    warmModules: "/opt/plow/openclaw-warm-modules.txt",
    // The boot code on disk, which after an upgrade's file swap is the new image's.
    prepare: () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["/opt/plow/boot/main.js", "--prepare"], { stdio: "inherit", env: process.env });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`--prepare exited ${code}`)));
    }),
  });
  process.off("SIGUSR2", early);
} catch (error) {
  if (prepareOnly) {
    console.error(`plow-boot: standby config failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.error(`plow-boot: parked: ${error instanceof Error ? error.message : String(error)}`);
  setInterval(() => {}, 2 ** 30);
}
