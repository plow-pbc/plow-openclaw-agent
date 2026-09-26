import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
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

for (const accountId of ["chat", "email"]) for (const status of [200, 403, 503, "unserved", "inactive"] as const) test(`native send checks account reach and reports only confirmed sends: ${accountId}, ${status}`, async t => {
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const posts: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body as string));
      return Response.json({ uid: "sent-message" }, { status: typeof status === "number" ? status : 200 });
    }
    return Response.json({ uid: "target", status: status === "inactive" ? "inactive" : "active", participants: [
      { type: "agent", relationship: "self", line: { uid: status === "unserved" ? "other-line" : accountId } },
    ] });
  });
  const result = channel!.outbound.sendText({ cfg: { channels: { plow: { apiBase: "http://fixture", lineUid: "chat", emailLineUid: "email" } } }, accountId, to: "target", text: "Friday at noon." });
  if (status === 200) assert.deepEqual(await result, { channel: "plow", messageId: "sent-message" });
  else await assert.rejects(result, typeof status === "string" ? /does not serve/ : status === 503 ? /delivery is unknown/ : /HTTP 403/);
  assert.deepEqual(posts, typeof status === "string" ? [] : [{ body: "Friday at noon.", attachment_uids: [] }]);
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

test("owner-targeted delivery resolves the sentinel to the owner's phone chat", async t => {
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const chat = { uid: "cht_home", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "member", role: "owner" },
  ] };
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    if (url.endsWith("/chats")) return Response.json({ data: [chat], has_more: false });
    if (url.endsWith("/chats/cht_home")) return Response.json(chat);
    if (url.endsWith("/chats/cht_home/messages")) return Response.json({ uid: "delivered" });
    return new Response(null, { status: 404 });
  });
  assert.deepEqual(await channel!.outbound.sendText({ cfg: { channels: { plow: { apiBase: "http://fixture", lineUid: "line" } } },
    accountId: "chat", to: "plow-owner", text: "Reminder" }), { channel: "plow", messageId: "delivered" });
  assert.equal(urls.at(-1), "http://fixture/v1/chats/cht_home/messages");
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
