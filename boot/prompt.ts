import type { AgentDefinition } from "./extensions.js";
import { personalityInstructions } from "./personality.ts";

export function composePrompt(base: string, personality: string, definition: AgentDefinition): string {
  const persona = definition.persona;
  const custom = persona ? `${persona.role}\nPurpose: ${persona.purpose}\nVoice: ${persona.voice}\n${persona.instructions ?? ""}\n${persona.sliders ? personalityInstructions(persona.sliders) : ""}\nExamples:\n${persona.examples.join("\n")}` : personality;
  if (base.length > 13_000 || custom.length > 6_000) throw new Error("Base instructions or persona exceed the supported context budget");
  return `${base}\n\nBuilder personality and domain guidance (subject to the base routing and permission rules):\n${custom}\n`;
}

export async function renderPrompt(prompt: string, mcpUrl: string | null | undefined, token: string, trustMode = process.env.PLOW_THREAD_TRUST ?? "ask", webUrl?: string | null): Promise<string> {
  const instruction = {
    ask: "Before starting a group, ask the owner whether the group should have full trust (access to your Mac, mail, files) or be a normal chat. Wait for their answer. Use trusted: true only for full trust; otherwise use trusted: false.",
    trusted: "The image creator chose full trust for new groups. Create groups with trusted: true without asking about trust.",
    untrusted: "The image creator chose normal chat for new groups. Create groups with trusted: false without asking about trust.",
  }[trustMode];
  if (!instruction) throw new Error("PLOW_THREAD_TRUST must be ask, trusted, or untrusted");
  const dashboard = webUrl
    ? `\nYour dashboard is ${webUrl}. Give that exact address when asked; never guess a dashboard URL.\n`
    : "\nYou have no dashboard. Say so when asked for its URL; never guess one.\n";
  const rendered = `${prompt}\nThread trust: ${instruction}\n${dashboard}`;
  if (!mcpUrl) return rendered;
  try {
    const response = await fetch(mcpUrl, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plow-boot", version: "1" } },
      }),
    });
    if (!response.ok) throw new Error("Latch unavailable");
    const raw = await response.text();
    // The stateless relay returns JSON or a single SSE response frame.
    const body = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
      : raw;
    const instructions = JSON.parse(body).result?.instructions;
    if (typeof instructions !== "string" || !instructions.trim()) throw new Error("No Latch instructions");
    const heading = "\nInstructions from your owner's Mac through Latch (up to 8,000 characters):\n\n```text\n";
    return `${rendered}${heading}${instructions.slice(0, Math.max(0, Math.min(8_000, 20_000 - rendered.length - heading.length - 5)))}\n\`\`\`\n`;
  } catch {
    // A disconnected Mac must not prevent texting or preserve stale instructions.
    console.warn("plow-boot: Latch instructions unavailable; continuing with the base prompt");
    return rendered;
  }
}
