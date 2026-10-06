import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSON5 from "json5";
import { agentDefinitionSchema, type AgentDefinition } from "./extensions.ts";

export type Participant =
  | { type: "member"; uid: string; role: string }
  | { type: "agent"; relationship: string; line: { uid: string } };
export type Identity = {
  agent?: { name?: string | null; web_url?: string | null };
  line: { uid: string };
  mailbox?: { uid: string; display_name: string } | null;
  chats: { uid: string; status: string; participants: Participant[] }[];
  mcp_url?: string | null;
};

export function renderConfig(identity: Identity, apiBase: string, definition: AgentDefinition = agentDefinitionSchema.parse({ version: 1 })) {
  const extensions = definition.plugins;
  const threadTrust = process.env.PLOW_THREAD_TRUST ?? definition.defaults.threadTrust;
  if (threadTrust !== "ask" && threadTrust !== "trusted" && threadTrust !== "untrusted") {
    throw new Error("PLOW_THREAD_TRUST must be ask, trusted, or untrusted");
  }
  const guestTools = [...new Set(process.env.PLOW_GUEST_TOOLS === undefined ? definition.guestTools : process.env.PLOW_GUEST_TOOLS.split(",").map(name => name.trim()).filter(Boolean))];
  const name = identity.agent?.name;
  if (typeof name !== "string" || !name.trim()) throw new Error(`Identity has no usable agent.name: ${JSON.stringify(name)}`);
  return {
    meta: {},
    gateway: {
      mode: "local", bind: "loopback", port: 3000, controlUi: { enabled: true, allowedOrigins: ["*"] },
      auth: { mode: "trusted-proxy", trustedProxy: {
        userHeader: "x-plow-user", allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
      } },
      trustedProxies: ["127.0.0.1"],
      reload: { mode: "off" },
    },
    models: { providers: { plow: {
      baseUrl: `${apiBase}/v1`, apiKey: "${PLOW_AGENT_TOKEN}", api: "openai-completions", authHeader: true,
      request: { allowPrivateNetwork: true },
      // OpenClaw's idle timeout resets on every streamed token, so only an
      // output cap ends a model stuck in a loop. Plow forwards max_tokens, not
      // OpenClaw's default max_completion_tokens.
      models: [
        { id: "z-ai/glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 1048576, maxTokens: 16384, compat: { maxTokensField: "max_tokens" }, cost: { input: 0.5544, output: 1.7424 } },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", input: ["text", "image"], contextWindow: 1000000, maxTokens: 16384, compat: { maxTokensField: "max_tokens" }, cost: { input: 2.00, output: 10.00 } },
      ],
    } } },
    agents: { entries: { main: { identity: { name } } }, defaults: {
      workspace: "/var/lib/plow/workspace", skipBootstrap: true,
      // A phone turn, not OpenClaw's 48-hour default: a stuck run blocks its chat.
      timeoutSeconds: 600,
      silentReply: { group: "allow" },
      model: { primary: "plow/z-ai/glm-5.2", fallbacks: ["plow/anthropic/claude-sonnet-5"] }, sandbox: { mode: "off" },
      // Model params must not become a legacy model-selection allowlist.
      modelPolicy: {},
      models: { "plow/z-ai/glm-5.2": { params: { extraBody: { reasoning: { enabled: false } } } } },
      heartbeat: { target: "plow", to: "plow-heartbeat", accountId: "chat" },
    } },
    mcp: { sessionIdleTtlMs: 300_000, ...(identity.mcp_url ? { servers: { plow: {
      url: "http://127.0.0.1:18790/mcp", transport: "streamable-http",
      headers: { Authorization: "Bearer ${PLOW_MCP_BRIDGE_TOKEN}" },
    } } } : {}) },
    plugins: { load: { paths: ["/opt/plow/plugin", ...extensions.map(value => value.path)] },
      entries: { plow: { enabled: true }, ...Object.fromEntries(extensions.map(value => [value.id,
        { enabled: true, hooks: { allowConversationAccess: value.conversationAccess } }])) } },
    messages: { visibleReplies: "automatic", queue: { mode: "collect" }, inbound: { byChannel: { plow: 2000 } } },
    channels: { plow: {
      apiBase, lineUid: identity.line.uid, threadTrust, guestTools,
      ...(identity.mailbox ? { emailLineUid: identity.mailbox.uid, emailName: identity.mailbox.display_name } : {}),
    } },
    session: { dmScope: "per-account-channel-peer", groupScope: "per-group" },
    bindings: [{ agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } }, session: { dmScope: "main" } }],
    commands: { ownerAllowFrom: ["plow-owner"] },
    memory: { search: { rememberAcrossConversations: false } },
    // An empty allowlist means unrestricted in OpenClaw.
    skills: { load: { extraDirs: ["/opt/plow/skills", ...definition.skills] }, allowBundled: ["plow-no-bundled-skills"] },
    // Keep workspace and durable memory writes local instead of routing them through the Mac relay.
    tools: { message: { crossContext: { allowWithinProvider: false, allowAcrossProviders: false } }, profile: "messaging", toolSearch: false, sessions: { visibility: "tree" }, alsoAllow: ["automations", "read", "write", "edit", "exec", "plow_start_thread", "plow_set_thread_trust", "plow_reply_to", "plow_send_email", "plow_preferences", "plow_memory", "plow_room", ...guestTools, ...extensions.flatMap(value => value.tools)], deny: ["ask_user"] },
  };
}

const ownedPaths = [
  ["gateway", ["gateway"]],
  ["plow-provider", ["models", "providers", "plow"]],
  ["plow-mcp", ["mcp", "servers", "plow"]],
  ["plow-channel", ["channels", "plow"]],
  ["plow-plugin", ["plugins", "entries", "plow"]],
  ["plugin-load", ["plugins", "load"]],
  ["tools", ["tools"]],
  ["commands", ["commands"]],
  ["visible-replies", ["messages", "visibleReplies"]],
  ["message-queue", ["messages", "queue"]],
  ["inbound-debounce", ["messages", "inbound", "byChannel", "plow"]],
  ["identity", ["agents", "entries", "main", "identity"]],
  ["run-timeout", ["agents", "defaults", "timeoutSeconds"]],
  ["session", ["session"]],
  ["memory", ["memory"]],
] as const;

type ConfigObject = Record<string, unknown>;

function isObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(root: ConfigObject, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) node = isObject(node) ? node[key] : undefined;
  return node;
}

function parentAt(root: ConfigObject, path: readonly string[], create: boolean): ConfigObject | undefined {
  let node = root;
  for (const key of path.slice(0, -1)) {
    let next = node[key];
    if (!isObject(next)) {
      if (!create) return undefined;
      next = {};
      node[key] = next;
    }
    node = next as ConfigObject;
  }
  return node;
}

function isPlowOwnerBinding(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.match)) return false;
  const match = value.match;
  return value.agentId === "main" && match.channel === "plow" && match.accountId === "chat"
    && isObject(match.peer) && match.peer.kind === "direct" && match.peer.id === "plow-owner";
}

function seedExtensions(owner: ConfigObject, entries: ReturnType<typeof renderConfig>["plugins"]["entries"]): void {
  const parent = parentAt(owner, ["plugins", "entries", "plow"], true);
  if (!parent) return;
  for (const [id, defaults] of Object.entries(entries)) {
    if (id !== "plow" && parent[id] === undefined) parent[id] = defaults;
  }
}

export async function syncConfig(
  rendered: ReturnType<typeof renderConfig>, configPath: string, includeDir: string,
): Promise<void> {
  const seed = rendered as unknown as ConfigObject;
  await mkdir(includeDir, { recursive: true });
  let owner: ConfigObject;
  try {
    const parsed: unknown = JSON5.parse(await readFile(configPath, "utf8"));
    if (!isObject(parsed)) throw new Error("openclaw.json must contain an object");
    owner = parsed;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    owner = structuredClone(seed);
  }

  const skillDirs = getPath(owner, ["skills", "load", "extraDirs"]);
  if (skillDirs !== undefined && (!Array.isArray(skillDirs) || !skillDirs.every(dir => typeof dir === "string"))) throw new Error("skills.load.extraDirs must be an array of paths so image skills can be merged");
  const skills = parentAt(owner, ["skills", "load", "extraDirs"], true)!;
  skills.extraDirs = [...new Set([...rendered.skills.load.extraDirs, ...(Array.isArray(skillDirs) ? skillDirs : [])])];
  seedExtensions(owner, rendered.plugins.entries);
  for (const [file, path] of ownedPaths) {
    const value = getPath(seed, path);
    const parent = parentAt(owner, path, value !== undefined);
    if (!parent) continue;
    const key = path.at(-1)!;
    const includePath = join(includeDir, `${file}.json5`);
    if (value === undefined) {
      delete parent[key];
      await rm(includePath, { force: true });
    } else {
      await writeFile(includePath, JSON.stringify(value, null, 2) + "\n");
      parent[key] = { $include: includePath };
    }
  }
  // An existing config keeps whatever heartbeat route it was born with, so one still on OpenClaw's
  // implicit owner route moves to the marked one; any other heartbeat setting stays. An explicit
  // route is the owner's choice, "none" (OpenClaw's own advice for silencing them) included.
  const defaults = isObject(owner.agents) && isObject(owner.agents.defaults) ? owner.agents.defaults : undefined;
  if (defaults) {
    const silence = defaults.silentReply;
    if (silence === undefined) defaults.silentReply = rendered.agents.defaults.silentReply;
    else if (isObject(silence) && silence.group === undefined) silence.group = "allow";
  }
  const heartbeat = defaults?.heartbeat;
  if (defaults && (heartbeat === undefined || (isObject(heartbeat) && (heartbeat.target ?? "owner") === "owner"))) {
    defaults.heartbeat = { ...(isObject(heartbeat) ? heartbeat : {}), ...rendered.agents.defaults.heartbeat };
  }
  const bindingPath = join(includeDir, "binding.json5");
  await writeFile(bindingPath, JSON.stringify(rendered.bindings[0], null, 2) + "\n");
  const ownerBindings = Array.isArray(owner.bindings) ? owner.bindings.filter(binding =>
    !(isObject(binding) && binding.$include === bindingPath) && !isPlowOwnerBinding(binding)) : [];
  owner.bindings = [{ $include: bindingPath }, ...ownerBindings];
  const temporaryPath = `${configPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, configPath);
}
