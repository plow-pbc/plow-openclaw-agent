export async function renderPrompt(prompt: string, mcpUrl: string | null | undefined, token: string, trustMode = process.env.PLOW_THREAD_TRUST ?? "ask"): Promise<string> {
  const instruction = {
    ask: "Before starting a group, ask the owner whether the group should have full trust (access to your Mac, mail, files) or be a normal chat. Wait for their answer. Use trusted: true only for full trust; otherwise use trusted: false.",
    trusted: "The image creator chose full trust for new groups. Create groups with trusted: true without asking about trust.",
    untrusted: "The image creator chose normal chat for new groups. Create groups with trusted: false without asking about trust.",
  }[trustMode];
  if (!instruction) throw new Error("PLOW_THREAD_TRUST must be ask, trusted, or untrusted");
  const rendered = `${prompt}\nThread trust: ${instruction}\n`;
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
    return `${rendered}\nInstructions from your owner's Mac through Latch (up to 8,000 characters):\n\n\`\`\`text\n${instructions.slice(0, 8_000)}\n\`\`\`\n`;
  } catch {
    // A disconnected Mac must not prevent texting or preserve stale instructions.
    console.warn("plow-boot: Latch instructions unavailable; continuing with the base prompt");
    return rendered;
  }
}
