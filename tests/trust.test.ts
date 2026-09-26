import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const toolEntry = (await import(new URL("../plugin/index.ts?trust-tool-runtime", import.meta.url).href)).default as typeof entry;
type Tool = { name: string; execute: (id: string, args: object) => Promise<unknown> };

for (const scene of ["owner DM", "owner group", "member group", "owner email"] as const) test(`set trust from ${scene}`, async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const accountId = scene === "owner email" ? "email" : "chat";
  const account = { apiBase, accountId, lineUid: "line", emailLineUid: "email-line" };
  const cfg = { channels: { plow: account } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const member = { ...owner, uid: "member", role: "member" };
  const self = { type: "agent", relationship: "self", line: { uid: accountId === "email" ? "email-line" : "line" } };
  const chat = { uid: scene === "owner DM" ? "home" : "group", status: "active", trusted: false,
    participants: scene === "owner DM" ? [self, owner] : [self, owner, member] };
  const sender = scene === "member group" ? member : owner;
  const updates: { url: string; method: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "PUT") {
      updates.push({ url, method: options.method, body: JSON.parse(options.body as string) });
      return Response.json({ trusted: true });
    }
    return Response.json(url.endsWith("/chats/cht_target") ? { ...chat, uid: "cht_target", participants: [self, owner, member] } :
      url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith(`/chats/${chat.uid}`) ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "inbound", chat_id: chat.uid,
    data: { message: { uid: "inbound", direction: "inbound", sender, body: "Make that thread trusted", attachments: [], created_at: new Date().toISOString() } },
  })));
  const sessionKey = scene === "owner DM" ? "agent:main:main" : `agent:main:plow:group:${chat.uid}`;
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  let tool: Tool | undefined;
  let result: unknown;
  let failure: unknown;
  const runtime = { channel: {
    routing: { resolveAgentRoute: () => ({ sessionKey }) },
    inbound: {
      buildContext: async () => ({}),
      dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
        try { result = await tool!.execute("call", { chat_uid: "cht_target", trusted: true }); }
        catch (error) { failure = error; }
        replyOptions.onAgentRunTerminalOutcome("completed");
        controller.abort();
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      },
    },
  } };
  entry.register({ registrationMode: "full", runtime, logger: { info() {} }, registerTool() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  toolEntry.register({ registrationMode: "full", runtime, logger: { info() {} }, registerChannel() {},
    registerTool(factory: (context: object) => Tool) {
      const candidate = factory({ config: cfg, sessionKey, messageChannel: "plow", agentAccountId: accountId, nativeChannelId: chat.uid });
      if (candidate.name === "plow_set_thread_trust") tool = candidate;
    },
  });
  assert.ok(tool);
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  if (scene === "owner DM") {
    assert.equal(failure, undefined);
    assert.deepEqual((result as { details: unknown }).details, { chat_uid: "cht_target", trusted: true });
    assert.deepEqual(updates, [{ url: `${apiBase}/v1/chats/cht_target/trusted`, method: "PUT", body: { trusted: true } }]);
  } else {
    assert.match((failure as Error)?.message, /owner's main Plow DM/);
    assert.deepEqual(updates, []);
  }
});

test("an untrusted group member can ask only the owner, with no destination choice", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const cfg = { channels: { plow: account } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const member = { ...owner, uid: "member", role: "member", display_name: "Joe" };
  const self = { type: "agent", relationship: "self", line: { uid: "line" } };
  const home = { uid: "cht_home", status: "active", trusted: true, participants: [self, owner] };
  const group = { uid: "cht_group", display_name: "Lunch crew", status: "active", trusted: false, participants: [self, owner, member] };
  const posts: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "POST" && url.endsWith("/messages")) {
      posts.push({ url, body: JSON.parse(options.body as string) });
      return Response.json({ uid: "sent" });
    }
    return Response.json(url.endsWith("/chats") ? { data: [home, group], has_more: false } :
      url.endsWith("/chats/cht_home") ? home : url.endsWith("/chats/cht_group") ? group :
        url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "inbound", chat_id: group.uid,
    data: { message: { uid: "inbound", direction: "inbound", sender: member, body: "Monday at one for lunch?", attachments: [], created_at: new Date().toISOString() } },
  })));
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  let tool: Tool | undefined;
  const sessionKey = "agent:main:plow:group:cht_group";
  const runtime = { channel: {
    routing: { resolveAgentRoute: () => ({ sessionKey }) },
    inbound: {
      buildContext: async () => ({}),
      dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
        await tool!.execute("call", { text: "Joe proposed lunch Monday at 1. Want me to book it?" });
        replyOptions.onAgentRunTerminalOutcome("completed");
        controller.abort();
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      },
    },
  } };
  entry.register({ registrationMode: "full", runtime, logger: { info() {} }, registerTool() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  toolEntry.register({ registrationMode: "full", runtime, logger: { info() {} }, registerChannel() {},
    registerTool(factory: (context: object) => Tool) {
      const candidate = factory({ config: cfg, sessionKey, messageChannel: "plow", agentAccountId: "chat", nativeChannelId: group.uid });
      if (candidate.name === "plow_ask_owner") tool = candidate;
    },
  });
  assert.ok(tool);
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  assert.deepEqual(posts, [{ url: `${apiBase}/v1/chats/cht_home/messages`, body: {
    body: "In Lunch crew, Joe asks: Joe proposed lunch Monday at 1. Want me to book it?", attachment_uids: [],
  } }]);
});
