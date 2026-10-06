import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { nativeSendPolicy } from "./native-message-policy.ts";
import entry from "../plugin/index.ts";
import { renderConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";

test("the messaging agent can schedule durable reminders with the native scheduler", async () => {
  const { resolveToolProfilePolicy, mergeAlsoAllowPolicy } = await import("/app/dist/tool-policy-BFtbULCH.mjs");
  const { filterToolsByPolicy } = await import("/app/dist/tool-policy-match-CgrEQaD6.mjs");
  const { tools } = renderConfig(probeIdentity, "http://fixture");
  const profile = mergeAlsoAllowPolicy(resolveToolProfilePolicy(tools.profile), tools.alsoAllow);
  const available = filterToolsByPolicy([{ name: "automations" }, { name: "message" }, { name: "ask_user" }], {
    ...profile, deny: tools.deny,
  });
  assert.deepEqual(available.map((tool: { name: string }) => tool.name), ["automations", "message"]);
});

for (const mode of ["full", "discovery", "tool-discovery"]) test(`${mode} exposes Plow tools with a run-scoped delivery guard`, async () => {
  const names: string[] = [];
  const hooks: string[] = [];
  entry.register({
    registrationMode: mode, registerChannel() {}, runtime: {}, logger: { info() {} },
    registerTool(factory: (context: object) => { name: string }) { names.push(factory({}).name); },
    on(name: string) { hooks.push(name); },
  });
  assert.deepEqual(names, ["plow_start_thread", "plow_set_thread_trust", "plow_reply_to", "plow_send_email"]);
  const manifest = JSON.parse(await readFile(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts.tools, names);
  assert.ok(hooks.includes("before_tool_call"));
  assert.equal(hooks.filter(name => name === "after_tool_call").length, 1);
});

test("start-thread refuses outside an active main Plow DM without a request", async t => {
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<unknown> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_start_thread") factory = value; } });
  assert.ok(factory);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return Response.json({ data: [{ uid: "home", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }, { type: "member", role: "owner" }] }], has_more: false }); });
  const config = { channels: { plow: { apiBase: "http://fixture", lineUid: "line" } } };
  for (const context of [
    { config, sessionKey: "agent:main:main" },
    { config, sessionKey: "agent:main:plow:group:other", messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "group" },
    { config, sessionKey: "agent:main:main", messageChannel: "webchat" },
  ]) await assert.rejects(factory(context).execute("call", { members: ["+15550000002"], body: "Meet Friday?" }), /owner's main Plow DM/);
  assert.deepEqual(calls, []);
});

test("start-thread returns a tool error without config and makes no request", async t => {
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<unknown> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_start_thread") factory = value; } });
  assert.ok(factory);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not request"); });
  assert.deepEqual(await factory({}).execute("call", { members: ["+15550000002"], body: "Hi" }), {
    isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("native message sends enforce the host's source conversation and provider policy", () => {
  nativeSendPolicy("cht_source", "cht_source");
  assert.throws(() => nativeSendPolicy("cht_source", "cht_other"), /Cross-context messaging denied/);
  assert.throws(() => nativeSendPolicy("cht_source", "cht_source", "slack"), /Cross-context messaging denied/);
});

test("native email sends are rejected before making a request", async t => {
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not request"); });
  await assert.rejects(channel!.outbound.sendText({
    cfg: { channels: { plow: { apiBase: "http://fixture", lineUid: "chat", emailLineUid: "email" } } },
    accountId: "email", to: "target", text: "Friday at noon.",
  }), /plow_send_email/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("native targets preserve opaque UID case and reject names and non-chat IDs", () => {
  let channel: { messaging: { normalizeTarget: (raw: string) => string | undefined; targetResolver: { looksLikeId: (raw: string, normalized?: string) => boolean } } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  const uid = "cht_AbCdef0123456789_-XyZqw";
  for (const target of [uid, `plow:${uid}`, `  plow:${uid}  `]) {
    const normalized = channel!.messaging.normalizeTarget(target);
    assert.equal(normalized, uid);
    assert.equal(channel!.messaging.targetResolver.looksLikeId(target, normalized), true);
  }
  for (const target of ["Joe", "+15550000001", "mem_owner", "cht_", "cht_a/b", "cht_a?b"]) {
    assert.equal(channel!.messaging.targetResolver.looksLikeId(target), false);
  }
});

test("heartbeat owner discovery identifies only the sentinel as a direct destination", () => {
  let channel: { messaging: { inferTargetChatType?: (params: { to: string }) => string | undefined } };
  entry.register({ registrationMode: "full", on() {}, runtime: {}, registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  assert.equal(channel!.messaging.inferTargetChatType?.({ to: "plow-owner" }), "direct");
  assert.equal(channel!.messaging.inferTargetChatType?.({ to: "cht_unknown" }), undefined);
});

test("message tool hint keeps sends in the current conversation", () => {
  let channel: { agentPrompt: { messageToolHints: () => string[] } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  const hint = channel!.agentPrompt.messageToolHints().join(" ");
  assert.match(hint, /message\(action=send\).*current conversation/);
  assert.match(hint, /plow_reply_to.*another conversation/);
  assert.doesNotMatch(hint, /owner-approved|approval/);
});
