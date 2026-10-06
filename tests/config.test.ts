import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import JSON5 from "json5";
import { agentDefinitionSchema } from "../boot/extensions.ts";
import { renderConfig, syncConfig, type Identity } from "../boot/config.ts";

const identity: Identity = {
  agent: { name: "Juniper" },
  line: { uid: "ln_phone" },
  chats: [{ uid: "cht_home", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "ln_phone" } },
    { type: "member", role: "owner", uid: "mem_owner" },
  ] }],
};

async function configFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "plow-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { path: join(dir, "openclaw.json"), includes: join(dir, "includes") };
}

test("fresh groups allow intentional model silence while existing owner policy survives restart", async t => {
  const fixture = await configFixture(t), rendered = renderConfig(identity, "http://fixture");
  await syncConfig(rendered, fixture.path, fixture.includes);
  const fresh = JSON5.parse(await readFile(fixture.path, "utf8"));
  assert.deepEqual(fresh.agents.defaults.silentReply, { group: "allow" });
  fresh.agents.defaults.silentReply = { group: "disallow" };
  await writeFile(fixture.path, JSON.stringify(fresh));
  await syncConfig(rendered, fixture.path, fixture.includes);
  assert.deepEqual(JSON5.parse(await readFile(fixture.path, "utf8")).agents.defaults.silentReply, { group: "disallow" });
});

test("only the owner's phone DM becomes main; other peers and groups stay isolated", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.ok(!("ownerChatUid" in config.channels.plow));
  assert.ok(!("ownerMemberUid" in config.channels.plow));
  assert.deepEqual(config.commands.ownerAllowFrom, ["plow-owner"]);
  assert.deepEqual(config.agents.defaults.heartbeat, { target: "plow", to: "plow-heartbeat", accountId: "chat" }, "heartbeats reach the owner through an alias their sends are marked by");
  assert.equal(config.session.dmScope, "per-account-channel-peer");
  assert.equal(config.session.groupScope, "per-group");
  assert.deepEqual(config.bindings[0], {
    agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } },
    session: { dmScope: "main" },
  });
});

test("mailbox and group chats cannot displace the owner's DM", () => {
  const config = renderConfig({ ...identity, mailbox: { uid: "ln_mail", display_name: "Elm" }, chats: [...identity.chats,
    { uid: "cht_email", status: "active", participants: [
      { type: "agent", relationship: "self", line: { uid: "ln_mail" } },
      { type: "member", role: "owner", uid: "mem_owner" },
    ] },
    { ...identity.chats[0], uid: "cht_group", participants: [...identity.chats[0].participants,
      { type: "member", role: "member", uid: "mem_guest" },
    ] },
  ] }, "http://api:8000");
  assert.ok(!("ownerChatUid" in config.channels.plow));
  assert.equal(config.channels.plow.emailLineUid, "ln_mail");
});

test("the mailbox comes from identity, so it is served before its first thread exists", () => {
  assert.equal(renderConfig({ ...identity, mailbox: { uid: "ln_mail", display_name: "Elm" } }, "http://api:8000").channels.plow.emailLineUid, "ln_mail");
  assert.ok(!("emailLineUid" in renderConfig({ ...identity, mailbox: null }, "http://api:8000").channels.plow));
});

test("boot accepts no owner chat or ambiguous owner chats without waiting", () => {
  for (const chats of [[], [...identity.chats, ...identity.chats]]) {
    assert.deepEqual(renderConfig({ ...identity, chats }, "http://api:8000").commands.ownerAllowFrom, ["plow-owner"]);
  }
});

test("provider and optional MCP use environment references, never credential values", () => {
  const config = renderConfig({ ...identity, mcp_url: "http://api:8000/relay" }, "http://api:8000");
  assert.equal(config.models.providers.plow.apiKey, "${PLOW_AGENT_TOKEN}");
  assert.equal(config.models.providers.plow.baseUrl, "http://api:8000/v1");
  assert.equal(config.gateway.auth.mode, "trusted-proxy");
  assert.equal("password" in config.gateway.auth, false);
  assert.equal(config.mcp?.servers.plow.url, "http://127.0.0.1:18790/mcp");
  assert.deepEqual(renderConfig(identity, "http://api:8000").mcp, { sessionIdleTtlMs: 300_000 });
});

test("GLM falls back to Sonnet on the Plow provider with explicit capacity and pricing", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.agents.defaults.model, {
    primary: "plow/z-ai/glm-5.2", fallbacks: ["plow/anthropic/claude-sonnet-5"],
  });
  assert.deepEqual(config.models.providers.plow.models, [{
    id: "z-ai/glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 1048576, maxTokens: 16384,
    compat: { maxTokensField: "max_tokens" },
    cost: { input: 0.5544, output: 1.7424 },
  }, {
    id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", input: ["text", "image"], contextWindow: 1000000, maxTokens: 16384,
    compat: { maxTokensField: "max_tokens" },
    cost: { input: 2.00, output: 10.00 },
  }]);
  assert.equal(config.agents.defaults.timeoutSeconds, 600);
});

test("the configured Plow provider permits an operator-controlled private endpoint", () => {
  const config = renderConfig(identity, "http://host.docker.internal:8080");
  assert.equal(config.models.providers.plow.request.allowPrivateNetwork, true);
});

test("MCP sessions share the loopback bridge and expire after five idle minutes", () => {
  const config = renderConfig({ ...identity, mcp_url: "https://relay.internal/mcp" }, "http://api:8000");
  assert.deepEqual(config.mcp, { sessionIdleTtlMs: 300_000, servers: { plow: {
    url: "http://127.0.0.1:18790/mcp", transport: "streamable-http",
    headers: { Authorization: "Bearer ${PLOW_MCP_BRIDGE_TOKEN}" },
  } } });
});

test("phone turns cannot block on ask_user", () => {
  assert.deepEqual(renderConfig(identity, "http://api:8000").tools.deny, ["ask_user"]);
});

test("guest tools default to empty and are declared once for channel and messaging policy", t => {
  const previous = process.env.PLOW_GUEST_TOOLS;
  t.after(() => { if (previous === undefined) delete process.env.PLOW_GUEST_TOOLS; else process.env.PLOW_GUEST_TOOLS = previous; });
  delete process.env.PLOW_GUEST_TOOLS;
  const baseline = renderConfig(identity, "http://api:8000");
  assert.deepEqual(baseline.channels.plow.guestTools, []);
  process.env.PLOW_GUEST_TOOLS = " guest_view, guest_pick, ,guest_view ";
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.channels.plow.guestTools, ["guest_view", "guest_pick"]);
  assert.deepEqual(config.tools.alsoAllow, [...baseline.tools.alsoAllow, "guest_view", "guest_pick"]);
});

test("native messaging retains local workspace and memory file tools", () => {
  const { tools } = renderConfig(identity, "http://api:8000");
  for (const name of ["read", "write", "edit", "exec", "automations", "sessions_spawn", "subagents"]) assert.ok(tools.alsoAllow.includes(name));
  assert.deepEqual(tools.message.crossContext, { allowWithinProvider: false, allowAcrossProviders: false });
  assert.equal(tools.profile, "messaging"); assert.equal(tools.toolSearch, false);
  assert.deepEqual(tools.media.image, { enabled: true, maxBytes: 8 * 1024 * 1024, timeoutSeconds: 45 });
  assert.equal(tools.media.audio.enabled, false); assert.equal(tools.media.video.enabled, false);
});

test("private transcript recall is disabled across isolated conversations", () => {
  assert.equal(renderConfig(identity, "http://api:8000").memory.search.rememberAcrossConversations, false);
});


test("the API agent name configures the assistant identity", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.agents.entries.main.identity, { name: "Juniper" });
});

for (const name of [undefined, null, "", "  "]) test(`missing agent name is not invented: ${JSON.stringify(name)}`, () => {
  assert.throws(() => renderConfig({ ...identity, agent: { name } }, "http://api:8000"), /no usable agent.name/);
});

test("the base image uses boot-owned config with the OpenClaw browser UI", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.equal(config.gateway.controlUi.enabled, true);
  assert.equal(config.agents.defaults.skipBootstrap, true);
  assert.deepEqual(config.messages, { visibleReplies: "automatic", queue: { mode: "collect" }, inbound: { byChannel: { plow: 2000 } } });
  assert.deepEqual(config.meta, {});
});

test("boot renders manifest trust defaults and validates environment overrides", () => {
  const previous = process.env.PLOW_THREAD_TRUST;
  try {
    delete process.env.PLOW_THREAD_TRUST;
    for (const mode of ["ask", "trusted", "untrusted"] as const) {
      const definition = agentDefinitionSchema.parse({ version: 1, defaults: { threadTrust: mode } });
      assert.equal(renderConfig(identity, "http://api:8000", definition).channels.plow.threadTrust, mode);
    }
    process.env.PLOW_THREAD_TRUST = "invalid";
    assert.throws(() => renderConfig(identity, "http://api:8000"), /PLOW_THREAD_TRUST/);
    process.env.PLOW_THREAD_TRUST = "trusted";
    assert.equal(renderConfig(identity, "http://api:8000").channels.plow.threadTrust, "trusted");
  } finally {
    if (previous === undefined) delete process.env.PLOW_THREAD_TRUST;
    else process.env.PLOW_THREAD_TRUST = previous;
  }
});

test("the dashboard uses the proxy's port and accepts origins checked by the proxy", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.gateway, {
    mode: "local", bind: "loopback", port: 3000,
    controlUi: { enabled: true, allowedOrigins: ["*"] },
    auth: { mode: "trusted-proxy", trustedProxy: {
      userHeader: "x-plow-user", allowLoopback: true,
      deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
    } },
    trustedProxies: ["127.0.0.1"],
    reload: { mode: "off" },
  });
});

test("fresh boot seeds owner defaults and external includes for Plow-owned settings", async t => {
  const { path, includes } = await configFixture(t);
  await syncConfig(renderConfig(identity, "http://api:8000"), path, includes);
  const owner = JSON5.parse(await readFile(path, "utf8"));
  assert.deepEqual(owner.meta, {});
  assert.equal(owner.agents.defaults.model.primary, "plow/z-ai/glm-5.2");
  assert.equal(owner.skills.load.extraDirs[0], "/opt/plow/skills");
  assert.deepEqual(owner.gateway, { $include: join(includes, "gateway.json5") });
  assert.equal(JSON5.parse(await readFile(join(includes, "plow-channel.json5"), "utf8")).threadTrust, "ask");
  assert.deepEqual(owner.messages.visibleReplies, { $include: join(includes, "visible-replies.json5") });
  assert.equal(JSON5.parse(await readFile(join(includes, "visible-replies.json5"), "utf8")), "automatic");
  assert.deepEqual(owner.bindings, [{ $include: join(includes, "binding.json5") }, { $include: join(includes, "channel-binding.json5") }]);
  assert.equal(JSON5.parse(await readFile(owner.agents.ownership.$include, "utf8")), "explicit");
  assert.deepEqual(JSON5.parse(await readFile(owner.agents.defaults.systemAgent.$include, "utf8")), { agentId: "main" });
  assert.deepEqual(JSON5.parse(await readFile(join(includes, "gateway.json5"), "utf8")).port, 3000);
});

test("restart migrates a full render and keeps owner edits outside Plow-owned paths", async t => {
  const { path, includes } = await configFixture(t);
  const old = renderConfig(identity, "http://old-api:8000") as Record<string, any>;
  old.channels.telegram = { enabled: true };
  old.models.providers.extra = { baseUrl: "https://example.com" };
  old.plugins.entries.extra = { enabled: true };
  old.agents.defaults.model.primary = "extra/model";
  old.agents.entries.main.identity.emoji = "old";
  old.agents.entries.main.default = true;
  delete old.agents.ownership;
  delete old.agents.defaults.systemAgent;
  delete old.agents.entries["plow-worker"];
  old.messages.queue = { mode: "steer", cap: 99 };
  old.messages.inbound = { debounceMs: 800, byChannel: { plow: 1, signal: 500 } };
  old.messages.groupChat = { visibleReplies: "message_tool" };
  old.bindings.unshift({ agentId: "extra", match: { channel: "telegram" } });
  old.agents.defaults.heartbeat = { every: "1h" }; // a config from before the marked route
  await writeFile(path, `// owner settings\n${JSON.stringify(old)}\n`);
  await syncConfig(renderConfig(identity, "http://new-api:8000"), path, includes);
  const owner = JSON5.parse(await readFile(path, "utf8"));
  assert.deepEqual(owner.channels.telegram, { enabled: true });
  assert.deepEqual(owner.models.providers.extra, { baseUrl: "https://example.com" });
  assert.deepEqual(owner.plugins.entries.extra, { enabled: true });
  assert.deepEqual(JSON5.parse(await readFile(join(includes, "message-queue.json5"), "utf8")), { mode: "collect" });
  assert.deepEqual(owner.messages.groupChat, { visibleReplies: "message_tool" });
  assert.equal(owner.messages.inbound.debounceMs, 800);
  assert.equal(owner.messages.inbound.byChannel.signal, 500);
  assert.equal(JSON5.parse(await readFile(owner.messages.inbound.byChannel.plow.$include, "utf8")), 2000);
  assert.equal(owner.agents.defaults.model.primary, "extra/model");
  assert.equal(JSON5.parse(await readFile(owner.agents.defaults.timeoutSeconds.$include, "utf8")), 600);
  assert.deepEqual(owner.agents.defaults.heartbeat, { every: "1h", target: "plow", to: "plow-heartbeat", accountId: "chat" }, "rebuilt agents get the marked route and keep their cadence");
  assert.deepEqual(owner.agents.entries.main.identity, { $include: join(includes, "identity.json5") });
  assert.equal(owner.agents.entries.main.default, undefined);
  assert.ok(owner.agents.entries["plow-worker"].$include);
  assert.equal(owner.bindings.length, 3);
  assert.deepEqual(owner.bindings[0], { $include: join(includes, "binding.json5") });
  assert.deepEqual(owner.bindings[1], { agentId: "extra", match: { channel: "telegram" } });
  assert.deepEqual(owner.bindings[2], { $include: join(includes, "channel-binding.json5") });
  assert.equal(JSON5.parse(await readFile(join(includes, "plow-provider.json5"), "utf8")).baseUrl, "http://new-api:8000/v1");
  owner.gateway.port = 9999;
  owner.channels.plow.enabled = false;
  await writeFile(path, JSON.stringify(owner));
  await syncConfig(renderConfig(identity, "http://newer-api:8000"), path, includes);
  const again = JSON5.parse(await readFile(path, "utf8"));
  assert.deepEqual(again.gateway, { $include: join(includes, "gateway.json5") });
  assert.deepEqual(again.channels.plow, { $include: join(includes, "plow-channel.json5") });
  assert.deepEqual(again.channels.telegram, { enabled: true });
  assert.deepEqual(again.messages.groupChat, { visibleReplies: "message_tool" });
  assert.equal(again.agents.defaults.model.primary, "extra/model");
});

test("an owner who routed heartbeats elsewhere, or silenced them, keeps that choice on restart", async t => {
  const { path, includes } = await configFixture(t);
  for (const choice of [{ target: "none" }, { target: "last", every: "2h" }]) {
    const old = renderConfig(identity, "http://api:8000") as Record<string, any>;
    old.agents.defaults.heartbeat = choice;
    await writeFile(path, JSON.stringify(old));
    await syncConfig(renderConfig(identity, "http://api:8000"), path, includes);
    assert.deepEqual(JSON5.parse(await readFile(path, "utf8")).agents.defaults.heartbeat, choice);
  }
});

test("MCP Plow server include disappears without a relay while owner MCP settings remain", async t => {
  const { path, includes } = await configFixture(t);
  await syncConfig(renderConfig({ ...identity, mcp_url: "https://relay.example" }, "http://api:8000"), path, includes);
  const owner = JSON5.parse(await readFile(path, "utf8"));
  owner.mcp.servers.other = { url: "https://other.example" };
  await writeFile(path, JSON.stringify(owner));
  await syncConfig(renderConfig(identity, "http://api:8000"), path, includes);
  const again = JSON5.parse(await readFile(path, "utf8"));
  assert.equal(again.mcp.servers.plow, undefined);
  assert.deepEqual(again.mcp.servers.other, { url: "https://other.example" });
  assert.equal(again.mcp.sessionIdleTtlMs, 300_000);
});
