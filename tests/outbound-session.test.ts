import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { renderConfig, type Identity } from "../boot/config.ts";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const runtimeDist = dirname(require.resolve("openclaw"));
const { resolveAgentRoute } = await import(require.resolve("openclaw/plugin-sdk/routing"));
const { listSessionEntries, resolveStorePath } = await import(require.resolve("openclaw/plugin-sdk/session-store-runtime"));
const { readVisibleSessionTranscriptMessageEntries } = await import(require.resolve("openclaw/plugin-sdk/session-transcript-runtime"));

// The message runner and plugin loader are internal to the pinned runtime.
async function runtimeFunction(prefix: string, name: string) {
  for (const file of (await readdir(runtimeDist)).filter(file => file.startsWith(prefix) && file.endsWith(".mjs"))) {
    const module = await import(pathToFileURL(join(runtimeDist, file)).href);
    const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
    if (typeof fn === "function") return fn;
  }
  throw new Error(`Pinned OpenClaw runtime is missing ${name}`);
}

test("message sends mirror owner notices into the inbound owner session and preserve group routing", async t => {
  const root = await mkdtemp("/tmp/plow-outbound-session-");
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.PLOW_AGENT_TOKEN = "fixture-token";
  const owner = { type: "member" as const, uid: "owner", role: "owner" };
  const self = { type: "agent" as const, relationship: "self", line: { uid: "line" } };
  const home = { uid: "cht_owner_fixture", status: "active", participants: [self, owner] };
  const group = { ...home, uid: "cht_group_fixture", participants: [...home.participants, { ...owner, uid: "guest", role: "member" }] };
  const identity: Identity = { agent: { name: "Probe" }, line: { uid: "line" }, chats: [home, group] };
  const posts: { path: string; body: { body: string; attachment_uids: string[] } }[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const chat = identity.chats.find(chat => req.url === `/v1/chats/${chat.uid}` || req.url === `/v1/chats/${chat.uid}/messages`);
    if (req.method === "POST" && chat && req.url!.endsWith("/messages")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      posts.push({ path: req.url!, body: JSON.parse(body) });
      res.end(JSON.stringify({ uid: `msg_fixture_${posts.length}` }));
    } else if (req.url === "/v1/chats") res.end(JSON.stringify({ data: identity.chats, has_more: false }));
    else if (chat) res.end(JSON.stringify(chat));
    else { res.statusCode = 404; res.end("{}"); }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cfg = renderConfig(identity, `http://127.0.0.1:${address.port}`);
  cfg.agents.defaults.workspace = join(root, "workspace");
  const loadPlugins = await runtimeFunction("loader-runtime-load-", "loadOpenClawPlugins");
  const registry = loadPlugins({ config: cfg, onlyPluginIds: ["plow"], throwOnLoadError: true });
  assert.equal(registry.plugins.find((plugin: { id: string }) => plugin.id === "plow")?.status, "loaded");
  const runMessageAction = await runtimeFunction("message-action-runner-", "runMessageAction");
  const ownerSession = resolveAgentRoute({ cfg, channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } }).sessionKey;
  assert.equal(ownerSession, "agent:main:main");
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  for (const [target, text, chatUid, expectedSession] of [
    ["plow-owner", "Want me to offer times?", home.uid, ownerSession],
    ["plow:plow-owner", "I can't read your Mac. Please reconnect Latch.", home.uid, ownerSession],
    [group.uid, "Your meeting is starting soon.", group.uid, "agent:main:plow:group:cht_group_fixture"],
  ]) {
    await t.test(target + ": " + text, async () => {
      const sent = await runMessageAction({ cfg, action: "send", agentId: "main", sessionKey: "agent:main:meetly-poll-fixture",
        params: { channel: "plow", accountId: "chat", target, message: text } });
      assert.equal(sent.sendResult.deliveryStatus, "sent");
      assert.deepEqual(posts.at(-1), { path: `/v1/chats/${chatUid}/messages`, body: { body: text, attachment_uids: [] } });
      const sessions = listSessionEntries({ storePath });
      const destination = sessions.find(({ sessionKey }: { sessionKey: string }) => sessionKey === expectedSession);
      assert.ok(destination, `sent notice must be mirrored in ${expectedSession}; found ${sessions.map(({ sessionKey }: { sessionKey: string }) => sessionKey).join(", ")}`);
      const transcript = await readVisibleSessionTranscriptMessageEntries({ storePath, sessionKey: expectedSession, sessionId: destination.entry.sessionId });
      assert.ok(transcript.some(({ message }: { message: { role: string; content: { type: string; text?: string }[] } }) =>
        message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === text)));
      t.diagnostic(`HTTP delivered ${chatUid}; assistant transcript recorded in ${expectedSession}: ${text}`);
    });
  }
  assert.deepEqual(listSessionEntries({ storePath }).map(({ sessionKey }: { sessionKey: string }) => sessionKey).sort(),
    [ownerSession, "agent:main:plow:group:cht_group_fixture"].sort());
});
