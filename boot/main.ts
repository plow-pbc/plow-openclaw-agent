import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { renderConfig, findOwnerChat } from "./config.js";
import { identityFromApi } from "./identity.js";
import { renderPrompt } from "./prompt.js";
import { startGateway } from "./process.js";

try {
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");
  let identity = (await identityFromApi(base, process.env.PLOW_AGENT_TOKEN))!;
  let waited = false;
  let nextLog = 0;
  while (!findOwnerChat(identity)) {
    waited = true;
    if (Date.now() >= nextLog) {
      console.log("plow-boot: waiting for the first text in the owner's chat");
      nextLog = Date.now() + 3_600_000;
    }
    await sleep(5_000);
    identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN, true) ?? identity;
  }
  const config = renderConfig(identity, base);
  if (waited) {
    await mkdir("/var/lib/plow/plow-checkpoints", { recursive: true });
    await writeFile(`/var/lib/plow/plow-checkpoints/${config.channels.plow.ownerChatUid}`, "", { flag: "wx" })
      .catch(error => { if (error.code !== "EEXIST") throw error; });
  }
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN));
  await writeFile("/var/lib/plow/openclaw.json", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`plow-boot: identity resolved to ${config.channels.plow.ownerChatUid}`);
  startGateway();
} catch (error) {
  console.error(`plow-boot: parked: ${error instanceof Error ? error.message : String(error)}`);
  setInterval(() => {}, 2 ** 30);
}
