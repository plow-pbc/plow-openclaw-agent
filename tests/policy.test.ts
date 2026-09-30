import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { nativeSendPolicy } from "./native-message-policy.ts";
import entry from "../plugin/index.ts";

for (const mode of ["full", "discovery", "tool-discovery"]) test(`${mode} exposes Plow tools without a tool-call gate`, async () => {
  const names: string[] = [];
  const hooks: string[] = [];
  entry.register({
    registrationMode: mode, registerChannel() {}, runtime: {}, logger: { info() {} },
    registerTool(factory: (context: object) => { name: string }) { names.push(factory({}).name); },
    on(name: string) { hooks.push(name); },
  });
  assert.deepEqual(names, ["plow_start_thread", "plow_set_thread_trust", "plow_ask_owner", "plow_reply_to"]);
  const manifest = JSON.parse(await readFile(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts.tools, names);
  assert.ok(!hooks.includes("before_tool_call"));
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
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} },
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
});
