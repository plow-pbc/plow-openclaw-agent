import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { personalitySchema } from "./personality.ts";

const imagePath = z.string().refine(path => isAbsolute(path) && resolve(path).startsWith("/opt/"), "Use an absolute image-owned path under /opt");
const toolName = z.string().regex(/^[a-z][a-z0-9_]*$/);
const extension = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).refine(id => id !== "plow"),
  path: imagePath, tools: z.array(toolName).max(100), conversationAccess: z.boolean(),
}).strict();
const extensions = z.array(extension).max(32).refine(items => new Set(items.map(item => item.id)).size === items.length, "Duplicate plugin id");
export const agentDefinitionSchema = z.object({
  version: z.literal(1),
  persona: z.object({
    role: z.string().trim().min(1).max(300), purpose: z.string().trim().min(1).max(1000),
    voice: z.string().trim().min(1).max(1000), instructions: z.string().max(2000).optional(),
    examples: z.array(z.string().max(500)).max(6).default([]),
    sliders: personalitySchema.optional(),
  }).strict().optional(),
  plugins: extensions.default([]), skills: z.array(imagePath).max(20).default([]),
  guestTools: z.array(toolName).max(100).default([]),
  defaults: z.object({
    groupMode: z.enum(["helper", "coordinator", "facilitator"]).default("helper"),
    threadTrust: z.enum(["ask", "trusted", "untrusted"]).default("ask"),
  }).strict().default({ groupMode: "helper", threadTrust: "ask" }),
}).strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentExtension = z.infer<typeof extension>;

async function immutableParents(path: string, checked = new Set<string>()): Promise<string> {
  const resolved = await realpath(path);
  if (!resolved.startsWith("/opt/")) throw new Error(`Image installation leaves /opt: ${path}`);
  // Check both the spelling used by the manifest and any symlink target.
  for (const file of [resolve(path), resolved]) {
    for (let parent = dirname(file); parent !== "/"; parent = dirname(parent)) {
      if (checked.has(parent)) break;
      const installed = await stat(parent);
      if (installed.uid !== 0 || (installed.mode & 0o022)) throw new Error(`Image installation parent must be root-owned and immutable: ${parent}`);
      checked.add(parent);
    }
  }
  return resolved;
}

export async function agentDefinition(path = "/opt/plow/agent.json"): Promise<AgentDefinition> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return agentDefinitionSchema.parse({ version: 1 });
    throw error;
  }
  if (resolve(path).startsWith("/opt/")) {
    await immutableParents(path);
    const installed = await stat(path);
    if (installed.uid !== 0 || (installed.mode & 0o022)) throw new Error("agent.json must be root-owned and immutable");
  }
  return agentDefinitionSchema.parse(Array.isArray(value) ? { version: 1, plugins: value } : value);
}

export async function agentExtensions(path = "/opt/plow/agent.json"): Promise<AgentExtension[]> {
  return (await agentDefinition(path)).plugins;
}

export async function assertImageInstallation(definition: AgentDefinition): Promise<void> {
  const checked = new Set<string>();
  const parents = new Set<string>();
  async function immutable(path: string): Promise<void> {
    const resolved = await immutableParents(path, parents);
    if (checked.has(resolved)) return;
    checked.add(resolved);
    const installed = await stat(resolved);
    if (installed.uid !== 0 || (installed.mode & 0o022)) throw new Error(`Image installation must be root-owned and immutable: ${path}`);
    if (installed.isDirectory()) for (const name of await readdir(resolved)) await immutable(join(resolved, name));
  }
  for (const path of [...definition.plugins.map(plugin => plugin.path), ...definition.skills]) {
    const installed = await stat(path);
    if (!installed.isDirectory()) throw new Error(`Image installation must be a directory: ${path}`);
    await immutable(path);
  }
  for (const plugin of definition.plugins) {
    const manifest = z.object({ id: z.literal(plugin.id), contracts: z.object({ tools: z.array(toolName) }).passthrough() }).passthrough().parse(JSON.parse(await readFile(`${plugin.path}/openclaw.plugin.json`, "utf8")));
    if (!plugin.tools.every(tool => manifest.contracts.tools.includes(tool))) throw new Error(`Image plugin ${plugin.id} does not declare its offered tools`);
  }
}
