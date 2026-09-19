import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConfig, findOwnerChat, type Identity } from "../boot/config.ts";

const identity: Identity = {
  line: { uid: "ln_phone" },
  chats: [{ uid: "cht_home", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "ln_phone" } },
    { type: "member", role: "owner", uid: "mem_owner" },
  ] }],
};

test("only the owner's phone DM becomes main; other peers and groups stay isolated", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.equal(config.channels.plow.ownerChatUid, "cht_home");
  assert.ok(!("ownerMemberUid" in config.channels.plow));
  assert.deepEqual(config.commands.ownerAllowFrom, ["mem_owner"]);
  assert.equal(config.session.dmScope, "per-account-channel-peer");
  assert.equal(config.session.groupScope, "per-group");
  assert.deepEqual(config.bindings[0], {
    agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: "mem_owner" } },
    session: { dmScope: "main" },
  });
});

test("mailbox and group chats cannot displace the owner's DM", () => {
  const config = renderConfig({ ...identity, chats: [...identity.chats,
    { uid: "cht_email", status: "active", participants: [
      { type: "agent", relationship: "self", line: { uid: "ln_mail", provider_type: "email" } },
      { type: "member", role: "owner", uid: "mem_owner" },
    ] },
    { ...identity.chats[0], uid: "cht_group", participants: [...identity.chats[0].participants,
      { type: "member", role: "member", uid: "mem_guest" },
    ] },
  ] }, "http://api:8000");
  assert.equal(config.channels.plow.ownerChatUid, "cht_home");
  assert.equal(config.channels.plow.emailLineUid, "ln_mail");
});

test("ambiguous or missing owner chats are refused", () => {
  assert.throws(() => renderConfig({ ...identity, chats: [] }, "http://api:8000"), /found 0/);
  assert.throws(() => renderConfig({ ...identity, chats: [...identity.chats, ...identity.chats] }, "http://api:8000"), /found 2/);
  assert.throws(() => renderConfig({ ...identity, chats: [{ ...identity.chats[0], status: "inactive" }] }, "http://api:8000"), /found 0/);
});

test("provider and optional MCP use environment references, never credential values", () => {
  const config = renderConfig({ ...identity, mcp_url: "http://api:8000/relay" }, "http://api:8000");
  assert.equal(config.models.providers.plow.apiKey, "${PLOW_AGENT_TOKEN}");
  assert.equal(config.models.providers.plow.baseUrl, "http://api:8000/v1");
  assert.equal(config.gateway.auth.token, "${OPENCLAW_GATEWAY_TOKEN}");
  assert.equal(config.mcp?.servers.plow.env.PLOW_AGENT_TOKEN, "${PLOW_AGENT_TOKEN}");
  assert.equal(renderConfig(identity, "http://api:8000").mcp, undefined);
});

test("Kimi falls back to Luna on the Plow provider with explicit capacity and pricing", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.agents.defaults.model, {
    primary: "plow/moonshotai/kimi-k2.5", fallbacks: ["plow/openai/gpt-5.6-luna"],
  });
  assert.deepEqual(config.models.providers.plow.models, [{
    id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", contextWindow: 262144,
    cost: { input: 0.45, output: 2.25 },
  }, {
    id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1050000,
    cost: { input: 0.20, output: 1.20 },
  }]);
});

test("the configured Plow provider permits an operator-controlled private endpoint", () => {
  const config = renderConfig(identity, "http://host.docker.internal:8080");
  assert.equal(config.models.providers.plow.request.allowPrivateNetwork, true);
});

test("the Plow MCP server uses the stdio bridge with environment credentials", () => {
  const config = renderConfig({ ...identity, mcp_url: "https://relay.internal/mcp" }, "http://api:8000");
  assert.deepEqual(config.mcp, { servers: { plow: {
    command: "node", args: ["/opt/plow/boot/mcp-bridge.js"],
    env: { PLOW_MCP_URL: "https://relay.internal/mcp", PLOW_AGENT_TOKEN: "${PLOW_AGENT_TOKEN}" },
  } } });
});

test("no owner chat is pending; malformed and ambiguous identities are refused", () => {
  assert.equal(findOwnerChat({ ...identity, chats: [] }), undefined);
  assert.equal(findOwnerChat(identity)?.uid, "cht_home");
  assert.throws(() => findOwnerChat({ ...identity, line: { uid: "" }, chats: [] }), /line/);
  assert.throws(() => findOwnerChat({ ...identity, chats: [...identity.chats, ...identity.chats] }), /found 2/);
});


test("MCP config does not inherit a host CA override", () => {
  const original = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = "/test-rig/ca.crt";
  try {
    const config = renderConfig({ ...identity, mcp_url: "http://relay/mcp" }, "http://api:8000");
    assert.ok(!("NODE_EXTRA_CA_CERTS" in config.mcp!.servers.plow.env));
  } finally {
    if (original === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = original;
  }
});


test("phone turns cannot block on ask_user", () => {
  assert.deepEqual(renderConfig(identity, "http://api:8000").tools.deny, ["ask_user"]);
});

test("native messaging replaces the bespoke send tool", () => {
  assert.deepEqual(renderConfig(identity, "http://api:8000").tools, {
    profile: "messaging", sessions: { visibility: "tree" }, alsoAllow: ["read", "exec", "plow_start_thread"], deny: ["ask_user"],
  });
});

test("private transcript recall is disabled across isolated conversations", () => {
  assert.equal(renderConfig(identity, "http://api:8000").memory.search.rememberAcrossConversations, false);
});
