import { createInterface } from "node:readline";

const url = process.env.PLOW_MCP_URL;
const token = process.env.PLOW_AGENT_TOKEN;
if (!url || !token) throw new Error("PLOW_MCP_URL and PLOW_AGENT_TOKEN are required");
let session: string | undefined;
let protocol: string | undefined;

// The relay completes each POST with JSON, SSE frames, or an empty notification acknowledgement.
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let rpc: { id?: string | number | null; method?: string } | undefined;
  try {
    rpc = JSON.parse(line);
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session } : {}),
        ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
      },
      body: line,
    });
    if (!response.ok) throw new Error(`Relay HTTP ${response.status}`);
    session = response.headers.get("mcp-session-id") ?? session;
    const raw = await response.text();
    const bodies = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/)
        .filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"))
      : [raw];
    for (const body of bodies.filter(body => body.trim())) {
      const reply = JSON.parse(body);
      if (rpc?.method === "initialize" && reply.id === rpc.id) protocol = reply.result?.protocolVersion;
      process.stdout.write(JSON.stringify(reply) + "\n");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Relay request failed";
    if (rpc && "id" in rpc) process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message },
    }) + "\n");
    else console.error(`plow-mcp-bridge: ${message}`);
  }
}
