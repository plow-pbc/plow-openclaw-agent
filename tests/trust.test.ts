import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getSessionEntry, resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const toolEntry = (await import(new URL("../plugin/index.ts?trust-tool-runtime", import.meta.url).href)).default as typeof entry;
type Tool = { name: string; execute: (id: string, args: object) => Promise<unknown> };
type Scene = "owner DM" | "owner group" | "member group" | "owner email" | "member DM" | "member email";

async function runInboundTool(t: TestContext, scene: Scene, toolName: string, args: object, options: {
  threadTrust?: "ask" | "trusted" | "untrusted";
} = {}) {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const accountId = scene.endsWith("email") ? "email" : "chat";
  const account = { apiBase, accountId, lineUid: "line", emailLineUid: "email-line", threadTrust: options.threadTrust ?? "ask" };
  const cfg = { channels: { plow: account }, plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const member = { ...owner, uid: "member", role: "member", provider_key: "+15550000002", display_name: "Joe" };
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
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (init.method === "PUT") {
      updates.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({ trusted: true });
    }
    if (init.method === "POST" && (url.endsWith("/messages") || url.endsWith("/chats"))) {
      posts.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({ uid: "sent" });
    }
    const target = { ...chat, uid: "cht_target", participants: [self, owner, member] };
    const emailTarget = { ...chat, uid: "cht_email_target", participants: [{ ...self, line: { uid: "email-line" } }, member] };
    const directTarget = { ...chat, uid: "cht_direct_target", participants: [{ ...self, line: { uid: "line" } }, member] };
    return Response.json(url.endsWith("/chats/cht_email_target") ? emailTarget : url.endsWith("/chats/cht_direct_target") ? directTarget : url.endsWith("/chats/cht_target") ? target :
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
  const runtime = { channel: {
    routing: { resolveAgentRoute: (input?: { peer?: { id: string } }) => ({
      agentId: "main", sessionKey: input?.peer?.id === "cht_email_target" ? "agent:main:plow:direct:cht_email_target"
        : scene === "owner DM" && input?.peer?.id === "cht_direct_target" ? "agent:main:plow:direct:cht_direct_target" : sessionKey,
    }) },
    session: { resolveStorePath, updateLastRoute },
    inbound: {
      buildContext: async () => ({}),
      dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
        try { result = await tool!.execute("call", args); }
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
      const candidate = factory({ config: cfg, sessionKey, messageChannel: "plow", agentAccountId: accountId, nativeChannelId: chat.uid, requesterSenderId: scene.startsWith("member") ? member.provider_key : "plow-owner", senderIsOwner: !scene.startsWith("member") });
      if (candidate.name === toolName) tool = candidate;
    },
  });
  assert.ok(tool);
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  return { apiBase, chat, result, failure, posts, updates,
    transcript: async (key = "agent:main:main") => {
      const entry = getSessionEntry({ agentId: "main", sessionKey: key });
      return entry?.sessionId ? await readVisibleSessionTranscriptMessageEntries({ agentId: "main", sessionKey: key, sessionId: entry.sessionId }) : [];
    } };
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

for (const [mode, requested, expected] of [
  ["untrusted", true, false], ["trusted", false, true],
] as const) test(`group creation enforces ${mode} mode when trusted=${requested}`, async t => {
  const { failure, posts } = await runInboundTool(t, "owner DM", "plow_start_thread",
    { members: ["+15550000002"], body: "Planning lunch", trusted: requested }, { threadTrust: mode });
  assert.equal(failure, undefined);
  assert.equal((posts[0].body as { trusted: boolean }).trusted, expected);
});

test("ask mode requires an explicit trust choice", async t => {
  const { failure, posts } = await runInboundTool(t, "owner DM", "plow_start_thread",
    { members: ["+15550000002"], body: "Planning lunch" }, { threadTrust: "ask" });
  assert.match((failure as Error)?.message, /explicit trust choice/);
  assert.deepEqual(posts, []);
});

for (const scene of ["owner group", "member group", "owner email"] as const) test(`reply tool from ${scene}`, async t => {
  const { failure, posts } = await runInboundTool(t, scene, "plow_reply_to", {
    account: "email", chat_uid: "cht_email_target", text: "Lunch is at noon.",
  });
  assert.match((failure as Error)?.message, /owner's main Plow DM/);
  assert.deepEqual(posts, []);
});

for (const { account, chatUid, text, sessionKey } of [
  { account: "email", chatUid: "cht_email_target", text: "Lunch is at noon.", sessionKey: "agent:main:plow:direct:cht_email_target" },
  { account: "chat", chatUid: "cht_direct_target", text: "See you at lunch.", sessionKey: "agent:main:plow:direct:cht_direct_target" },
] as const) test(`follow-up destination ${account}`, async t => {
  const { apiBase, result, failure, posts, transcript } = await runInboundTool(t, "owner DM", "plow_reply_to", {
    account, chat_uid: chatUid, text,
  });
  assert.equal(failure, undefined);
  assert.deepEqual((result as { details: unknown }).details, { message_uid: "sent" });
  assert.deepEqual(posts, [{ url: `${apiBase}/v1/chats/${chatUid}/messages`, body: { body: text, attachment_uids: [] } }]);
  assert.deepEqual((await transcript(sessionKey)).map(entry => [entry.role, entry.message.content[0].text]), [["assistant", text]]);
});

test("reply tool checks the destination account", async t => {
  const { failure, posts } = await runInboundTool(t, "owner DM", "plow_reply_to", {
    account: "chat", chat_uid: "cht_email_target", text: "Approved.",
  });
  assert.match((failure as Error)?.message, /does not serve this conversation/);
  assert.deepEqual(posts, []);
});
