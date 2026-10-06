import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { startAgentIndex } from "./agent-index.js";
import { agentDefinition, assertImageInstallation } from "./extensions.js";
import { renderConfig, syncConfig } from "./config.js";
import { identityFromApi } from "./identity.js";
import { installBootLog } from "./log.js";
import { composePrompt, renderPrompt } from "./prompt.js";
import { startGateway } from "./process.js";

try {
  const writeLog = installBootLog();
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_PASSWORD = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  const definition = await agentDefinition();
  await assertImageInstallation(definition);
  const config = renderConfig(identity, base, process.env.PLOW_THREAD_TRUST ?? definition.defaults.threadTrust, definition.plugins, definition);
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  await writeFile("/var/lib/plow/gateway-password", process.env.OPENCLAW_GATEWAY_PASSWORD + "\n", { mode: 0o600 });
  await chmod("/var/lib/plow/gateway-password", 0o600);
  for (const name of ["BOOTSTRAP.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await rm(`/var/lib/plow/workspace/${name}`, { force: true });
  }
  const prompt = composePrompt(await readFile("/opt/plow/prompt/BASE.md", "utf8"), await readFile("/opt/plow/prompt/AGENTS.md", "utf8"), definition);
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN, config.channels.plow.threadTrust, identity.agent?.web_url));
  await syncConfig(config, "/var/lib/plow/openclaw.json", "/etc/plow/openclaw");
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  startAgentIndex(300_000, writeLog);
  await startGateway(false, identity.mcp_url ?? undefined, writeLog);
} catch (error) {
  console.error(`plow-boot: parked: ${error instanceof Error ? error.message : String(error)}`);
  setInterval(() => {}, 2 ** 30);
}
