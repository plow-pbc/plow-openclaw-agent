import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type AgentExtension = { id: string; path: string; tools: string[]; conversationAccess: boolean };

// The root-owned image manifest declares extra native plugins. Owner settings
// remain in openclaw.json; this file only describes image installation.
export async function agentExtensions(path = "/opt/plow/agent.json"): Promise<AgentExtension[]> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if (!Array.isArray(value)) throw new Error("The image's agent.json must contain a plugin array");
  const seen = new Set<string>(["plow"]);
  return value.map(item => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string"
      || !/^[a-z][a-z0-9-]*$/.test(item.id) || seen.has(item.id)
      || !("path" in item) || typeof item.path !== "string" || !resolve(item.path).startsWith("/opt/")
      || !("tools" in item) || !Array.isArray(item.tools) || !item.tools.every((tool: unknown) => typeof tool === "string" && /^[a-z][a-z0-9_]*$/.test(tool))
      || !("conversationAccess" in item) || typeof item.conversationAccess !== "boolean") {
      throw new Error("Invalid or duplicate image plugin declaration");
    }
    seen.add(item.id);
    return { id: item.id, path: resolve(item.path), tools: item.tools, conversationAccess: item.conversationAccess };
  });
}
