import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const toolEntry = (await import(new URL("../plugin/index.ts?trust-tool-runtime", import.meta.url).href)).default as typeof entry;
type Tool = { name: string; execute: (id: string, args: object) => Promise<unknown> };
type Scene = "owner DM" | "owner group" | "member group" | "owner email" | "member DM" | "member email";

async function runInboundTool(t: TestContext, scene: Scene, toolName: string, args: object, deliveryFails = false) {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const accountId = scene.endsWith("email") ? "email" : "chat";
  const account = { apiBase, accountId, lineUid: "line", emailLineUid: "email-line" };
  const cfg = { channels: { plow: account } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const member = { ...owner, uid: "member", role: "member", display_name: "Joe" };
  const self = { type: "agent", relationship: "self", line: { uid: accountId === "email" ? "email-line" : "line" } };
  const home = { uid: "cht_home", status: "active", trusted: true,
    participants: [{ ...self, line: { uid: "line" } }, owner] };
  const chat = scene === "owner DM" ? home : {
    uid: scene.includes("group") ? "cht_group" : "cht_source", display_name: "Lunch crew", status: "active", trusted: false,
    participants: scene.includes("group") || scene === "owner email" ? [self, owner, member] : [self, member],
  };
  const sender = scene.startsWith("member") ? member : owner;
  const posts: { url: string; body: unknown }[] = [];
  const updates: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "PUT") {
      updates.push({ url, body: JSON.parse(options.body as string) });
      return Response.json({ trusted: true });
    }
    if (options.method === "POST" && url.endsWith("/messages")) {
      posts.push({ url, body: JSON.parse(options.body as string) });
      return deliveryFails ? Response.json({}, { status: 503 }) : Response.json({ uid: "sent" });
    }
    const target = { ...chat, uid: "cht_target", participants: [self, owner, member] };
    return Response.json(url.endsWith("/chats/cht_target") ? target :
      url.endsWith("/chats") ? { data: chat === home ? [home] : [home, chat], has_more: false } :
      url.endsWith(`/chats/${chat.uid}`) ? chat : url.endsWith("/chats/cht_home") ? home :
      url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "inbound", chat_id: chat.uid,
    data: { message: { uid: "inbound", direction: "inbound", sender, body: "Please ask the owner", attachments: [], created_at: new Date().toISOString() } },
  })));
  const sessionKey = scene === "owner DM" ? "agent:main:main" : `agent:main:plow:${scene.includes("group") ? "group" : "direct"}:${chat.uid}`;
  let channel: { gateway: { startAccount: (context: object) => Promise<void> }; outbound: { sendText: (context: object) => Promise<unknown> } } | undefined;
  let tool: Tool | undefined;
  let result: unknown;
  let failure: unknown;
  let retryFailure: unknown;
  const runtime = { channel: {
    routing: { resolveAgentRoute: () => ({ sessionKey }) },
    inbound: {
      buildContext: async () => ({}),
      dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
        try { result = await tool!.execute("call", args); }
        catch (error) { failure = error; }
        if (deliveryFails) {
          try { await channel!.outbound.sendText({ cfg, accountId, to: chat.uid, text: "Retry" }); }
          catch (error) { retryFailure = error; }
        }
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
      if (candidate.name === toolName) tool = candidate;
    },
  });
  assert.ok(tool);
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  return { apiBase, chat, result, failure, retryFailure, posts, updates,
    reply: (replyAccountId: string) => channel!.outbound.sendText({ cfg, accountId: replyAccountId, to: chat.uid, text: "Approved; I booked it." }) };
}

for (const scene of ["owner DM", "owner group", "member group", "owner email"] as const) test(`set trust from ${scene}`, async t => {
  const { apiBase, result, failure, updates } = await runInboundTool(t, scene, "plow_set_thread_trust", { chat_uid: "cht_target", trusted: true });
  if (scene === "owner DM") {
    assert.equal(failure, undefined);
    assert.deepEqual((result as { details: unknown }).details, { chat_uid: "cht_target", trusted: true });
    assert.deepEqual(updates, [{ url: `${apiBase}/v1/chats/cht_target/trusted`, body: { trusted: true } }]);
  } else {
    assert.match((failure as Error)?.message, /owner's main Plow DM/);
    assert.deepEqual(updates, []);
  }
});

for (const scene of ["member group", "member DM", "member email"] as const) test(`an untrusted ${scene} can ask the owner with the source account and chat uid`, async t => {
  const { apiBase, chat, failure, posts } = await runInboundTool(t, scene, "plow_ask_owner", { text: "Joe proposed lunch Monday at 1. Want me to book it?" });
  assert.equal(failure, undefined);
  assert.deepEqual(posts, [{ url: `${apiBase}/v1/chats/cht_home/messages`, body: {
    body: `In Lunch crew (${scene === "member email" ? "email" : "chat"} ${chat.uid}), Joe asks: Joe proposed lunch Monday at 1. Want me to book it?`, attachment_uids: [],
  } }]);
});

test("an owner can send an approved outcome to the email source", async t => {
  const { apiBase, chat, failure, posts, reply } = await runInboundTool(t, "member email", "plow_ask_owner", { text: "Can you book lunch?" });
  assert.equal(failure, undefined);
  assert.equal((posts[0].body as { body: string }).body, `In Lunch crew (email ${chat.uid}), Joe asks: Can you book lunch?`);
  await assert.rejects(reply("chat"), /does not serve this conversation/);
  assert.deepEqual(await reply("email"), { channel: "plow", messageId: "sent" });
  assert.deepEqual(posts[1], { url: `${apiBase}/v1/chats/${chat.uid}/messages`, body: {
    body: "Approved; I booked it.", attachment_uids: [],
  } });
});

test("an ambiguous owner notification latches delivery for the rest of the turn", async t => {
  const { chat, failure, retryFailure, posts } = await runInboundTool(t, "member group", "plow_ask_owner", { text: "Please ask." }, true);
  assert.match((failure as Error)?.message, /delivery is unknown/);
  assert.match((retryFailure as Error)?.message, /delivery is unknown/);
  assert.equal(posts.length, 1);
  assert.equal((posts[0].body as { body: string }).body, `In Lunch crew (chat ${chat.uid}), Joe asks: Please ask.`);
});
