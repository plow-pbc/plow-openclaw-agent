import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { getSessionEntry, resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const toolEntry = (await import(new URL("../plugin/index.ts?tool-runtime", import.meta.url).href)).default as typeof entry;
type Tool = { name: string; execute: (id: string, args: object) => Promise<{ isError?: boolean; content: { text: string }[] }> };
type Payload = { text?: string; isError?: boolean; isFallbackNotice?: boolean };
type Dispatch = {
  ctxPayload: { conversation: { id: string } };
  route: { sessionKey: string };
  delivery: { preparePayload: (payload: Payload, info: { kind: string }) => Payload | null; deliver: (payload: Payload) => Promise<unknown> };
};
type Context = { supplemental: { groupSystemPrompt?: string; channelStructuredContext: { label: string; payload: unknown }[] } };

const self = (line: string) => ({ type: "agent", relationship: "self", line: { uid: line, display_name: line === "mail" ? "Elm" : "Phone" } });
const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "owner@example.com" };
const outsider = { type: "member", uid: "outsider", role: "member", display_name: "Sender", provider_key: "sender@example.com" };
const chats: Record<string, { uid: string; status: string; trusted: boolean; display_name?: string; participants: object[] }> = {
  home: { uid: "home", status: "active", trusted: false, participants: [self("line"), owner] },
  group: { uid: "group", status: "active", trusted: true, participants: [self("line"), owner, { ...outsider, provider_key: "+15550000002" }] },
  thread: { uid: "thread", status: "active", trusted: false, display_name: "Booking", participants: [self("mail"), owner, outsider] },
  other: { uid: "other", status: "active", trusted: false, display_name: "Another", participants: [self("mail"), owner, outsider] },
  started: { uid: "started", status: "active", trusted: false, display_name: "Hello", participants: [self("mail"), owner, outsider] },
  dm: { uid: "dm", status: "active", trusted: false, participants: [self("line"), { ...outsider, provider_key: "+15550000003" }] },
};
// Chats this agent's credential can no longer read: their GET answers 403.
const forbidden = new Set<string>();
const cfg = { channels: { plow: { lineUid: "line", emailLineUid: "mail", emailName: "Elm" } } };
const transcript = async (sessionKey: string) => {
  const entry = getSessionEntry({ agentId: "main", sessionKey });
  return entry?.sessionId ? (await readVisibleSessionTranscriptMessageEntries({ agentId: "main", sessionKey, sessionId: entry.sessionId }))
    .map(entry => entry.message.content[0].text) : [];
};

// Runs one turn per frame on the given account; `turn` plays the model inside dispatch.
async function run(t: TestContext, accountId: "chat" | "email", frames: { chat: string; sender: object }[],
  turn: (dispatch: Dispatch, tool: () => Tool, channel: { outbound: { sendText: (context: object) => Promise<unknown> } }, config: object) => Promise<void>,
  newThread: { status: string; chat_uid: string | null; chat_unrecorded_reason?: string; http?: number } = { status: "sent", chat_uid: "started" }, state?: string, terminal = "completed") {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  if (state) process.env.OPENCLAW_STATE_DIR = state;
  const controller = abortAfter();
  const account = { ...cfg.channels.plow, apiBase, accountId };
  // The durable sender loads the plugin's outbound adapter from this path.
  const config = { channels: { plow: { ...cfg.channels.plow, apiBase } }, plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } } };
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    if (options.method === "POST" && path !== "/ws/ticket" && !path.endsWith("/typing")) {
      posts.push({ path, body: JSON.parse(options.body as string) });
      return path.startsWith("/email-lines/") ? Response.json(newThread, { status: newThread.http ?? 201 }) : Response.json({ uid: `sent-${posts.length}` });
    }
    if (path === "/chats") return Response.json({ data: Object.values(chats), has_more: false });
    if (forbidden.has(path.split("/")[2])) return Response.json({}, { status: 403 });
    // Only an email thread's newest message is served: the listing reads it for last activity.
    if (path.endsWith("/messages")) return Response.json(new URL(url).searchParams.get("limit") !== "1" || !["thread", "other", "started"].includes(path.split("/")[2]) ? { data: [], has_more: false } : { data: [{ uid: "newest", direction: "outbound", sender: self("mail"), body: "Earlier", attachments: [], created_at: "2026-09-28T12:00:00Z" }], has_more: false });
    return Response.json(chats[path.split("/")[2]] ?? { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => frames.forEach(({ chat, sender }, i) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: `event-${i}`, chat_id: chat,
    data: { message: { uid: `inbound-${i}`, direction: "inbound", sender, body: "hello", attachments: [], created_at: new Date().toISOString() } },
  }))));
  let channel: Parameters<typeof turn>[2] & { gateway: { startAccount: (context: object) => Promise<void> } };
  const factories: ((context: object) => Tool)[] = [];
  const contexts: Context[] = [];
  const logs: string[] = [];
  const api = { registrationMode: "full", logger: { info() {} }, on() {}, registerTool() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: ({ accountId, peer }: { accountId: string; peer: { kind: string; id: string } }) =>
        ({ agentId: "main", sessionKey: peer.id === "plow-owner" ? "agent:main:main" : `agent:main:plow:${accountId}:${peer.kind}:${peer.id}` }) },
      session: { resolveStorePath, updateLastRoute },
      inbound: {
      buildContext: async (value: Context & Dispatch["ctxPayload"]) => { contexts.push(value); return value; },
      dispatch: async (dispatch: Dispatch & { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
        const tool = () => factories.map(factory => factory({ config, sessionKey: dispatch.route.sessionKey, messageChannel: "plow", agentAccountId: accountId,
          nativeChannelId: dispatch.ctxPayload.conversation.id })).find(tool => tool.name === "plow_send_email")!;
        await turn(dispatch, tool, channel, config);
        dispatch.replyOptions.onAgentRunTerminalOutcome(terminal);
        if (contexts.length === frames.length) controller.abort();
        return { dispatched: true, dispatchResult: {} };
      },
    } } },
  };
  entry.register(api);
  // Tools run in a separate module instance, as they do in the gateway.
  toolEntry.register({ ...api, registerChannel() {}, registerTool(factory: (context: object) => Tool) { factories.push(factory); } });
  await channel!.gateway.startAccount({ account, cfg: config, abortSignal: controller.signal, log: { info(text: string) { logs.push(text); } } });
  return { posts, contexts, logs };
}

async function final(dispatch: Dispatch, payload: Payload, kind = "final") {
  const prepared = dispatch.delivery.preparePayload(payload, { kind });
  if (prepared) await dispatch.delivery.deliver(prepared);
}

test("a non-owner email turn's final goes to the owner's 1:1, labelled, and nothing reaches the thread", async t => {
  const text = "Not replying: this turn doesn't carry owner authority to send, so I'll let it close. ".repeat(4);
  const { posts, contexts, logs } = await run(t, "email", [{ chat: "thread", sender: outsider }], async dispatch => {
    await final(dispatch, { text: "working on it" }, "block");
    await final(dispatch, { text });
  });
  assert.deepEqual(posts.map(post => post.path), ["/chats/home/messages"]);
  assert.equal(posts[0].body.body, `Re: email "Booking" from Sender (sender@example.com) (thread thread)\n\n${text.trim()}`);
  assert.ok(logs.some(line => line.startsWith("completed chat=thread")));
  const prompt = contexts[0].supplemental.groupSystemPrompt!;
  assert.match(prompt, /You are Elm, your owner's assistant/);
  // Names senders chose never reach system-authority text.
  assert.doesNotMatch(prompt, /Sender|Owner\b/);
  assert.match(prompt, /plow_send_email, to "thread"/);
  assert.match(prompt, /never sent to this thread/);
});

test("NO_REPLY on an email turn is silence: no fallback notice anywhere, and the turn completes", async t => {
  const { posts, logs } = await run(t, "email", [{ chat: "thread", sender: outsider }], async dispatch => {
    await final(dispatch, { text: "No response generated.", isFallbackNotice: true });
  });
  assert.deepEqual(posts, []);
  assert.ok(logs.some(line => line.startsWith("completed chat=thread")));
});

for (const notice of [{ text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true }, { text: "⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. Reference: run-1." }]) test(`NO_REPLY that the runtime reports as no answer is silence on an email turn: ${notice.text.slice(3, 20)}`, async t => {
  const { posts, logs } = await run(t, "email", [{ chat: "thread", sender: outsider }], async dispatch => {
    await dispatch.delivery.deliver(notice);
  }, undefined, undefined, "failed");
  assert.deepEqual(posts, []);
  assert.ok(logs.some(line => line.startsWith("completed chat=thread")));
});

test("a runtime error notice on an email turn goes to the owner, never to the thread", async t => {
  const { posts } = await run(t, "email", [{ chat: "thread", sender: owner }], async dispatch => {
    await final(dispatch, { text: "Something went wrong.", isError: true });
  });
  assert.deepEqual(posts.map(post => post.path), ["/chats/home/messages"]);
});

test("on a non-owner email turn, message sends nothing anywhere, and the final still reaches the owner", async t => {
  const refusals: string[] = [];
  const { posts } = await run(t, "email", [{ chat: "thread", sender: outsider }], async (dispatch, _tool, channel) => {
    for (const [accountId, to] of [["chat", "plow:group"], ["chat", "plow-owner"], ["email", "plow:thread"]]) {
      await channel.outbound.sendText({ cfg: { channels: { plow: { ...cfg.channels.plow, apiBase: "http://fixture" } } }, accountId, to, text: "psst" })
        .catch((error: Error) => refusals.push(error.message));
    }
    await final(dispatch, { text: "For you" });
  });
  assert.equal(refusals.length, 3);
  assert.match(refusals[2], /plow_send_email/);
  assert.deepEqual(posts.map(post => post.path), ["/chats/home/messages"]);
});

test("message from an owner's email turn to its own thread is refused and names plow_send_email", async t => {
  let refusal = "";
  const { posts } = await run(t, "email", [{ chat: "thread", sender: owner }], async (_dispatch, _tool, channel, config) => {
    await channel.outbound.sendText({ cfg: config, accountId: "email", to: "plow:thread", text: "hi" }).catch((error: Error) => { refusal = error.message; });
  });
  assert.match(refusal, /plow_send_email/);
  assert.deepEqual(posts, []);
});

test("message from a phone turn to an email thread, even a brand-new one, is refused and names plow_send_email", async t => {
  let refusal = "";
  // No mailbox listener runs here, so nothing has seen the thread before this send.
  const { posts } = await run(t, "chat", [{ chat: "home", sender: owner }], async (_dispatch, _tool, channel, config) => {
    await channel.outbound.sendText({ cfg: config, accountId: "chat", to: "plow:started", text: "hi" }).catch((error: Error) => { refusal = error.message; });
  });
  assert.match(refusal, /plow_send_email/);
  assert.deepEqual(posts, []);
});

test("plow_send_email on a non-owner email turn replies only in its own thread", async t => {
  const results: { isError?: boolean; content: { text: string }[] }[] = [];
  const { posts } = await run(t, "email", [{ chat: "thread", sender: outsider }], async (_dispatch, tool) => {
    const send = tool();
    for (const args of [{ to: "other", body: "hi" }, { to: ["new@example.com"], subject: "Hi", body: "hi" }, { action: "list" }, { to: "thread", body: "Thanks, noted." }]) {
      results.push(await send.execute("call", args));
    }
  });
  assert.deepEqual(results.map(result => Boolean(result.isError)), [true, true, true, false]);
  assert.ok(results.slice(0, 3).every(result => JSON.parse(result.content[0].text).success === false));
  assert.deepEqual(JSON.parse(results[3].content[0].text), { sent: true, chat_uid: "thread" });
  assert.deepEqual(posts, [{ path: "/chats/thread/messages", body: { body: "Thanks, noted." } }]);
});

test("a thread started from a trusted group reports its finals to that group, recorded in the group's session", async t => {
  const state = await mkdtemp(`${tmpdir()}/plow-email-state-`);
  t.after(() => rm(state, { recursive: true }));
  let receipt: unknown;
  await run(t, "chat", [{ chat: "group", sender: outsider }], async (_dispatch, tool) => {
    const send = tool();
    receipt = JSON.parse((await send.execute("call", { to: ["new@example.com"], subject: "Hello", body: "Opening" })).content[0].text);
  }, undefined, state);
  assert.deepEqual(receipt, { sent: true, chat_uid: "started" });
  const { posts } = await run(t, "email", [{ chat: "started", sender: outsider }], async dispatch => { await final(dispatch, { text: "They replied yes." }); }, undefined, state);
  assert.deepEqual(posts.map(post => post.path), ["/chats/group/messages"]);
  assert.deepEqual(await transcript("agent:main:plow:chat:group:group"), [`Re: email "Hello" from Sender (sender@example.com) (thread started)\n\nThey replied yes.`]);
});

test("a new thread without a recorded chat is reported, not invented, and sent once", async t => {
  let receipt: Record<string, unknown> = {};
  const { posts } = await run(t, "chat", [{ chat: "home", sender: owner }], async (_dispatch, tool) => {
    const send = tool();
    receipt = JSON.parse((await send.execute("call", { to: ["new@example.com"], subject: "Hello", body: "Opening" })).content[0].text);
  }, { status: "sent", chat_uid: null, chat_unrecorded_reason: "persistence_failed" });
  assert.equal(receipt.chat_uid, null);
  assert.equal(receipt.chat_unrecorded_reason, "persistence_failed");
  assert.match(String(receipt.note), /do not resend/i);
  assert.deepEqual(posts.map(post => post.path), ["/email-lines/mail/messages"]);
});

test("plow_send_email lists threads for the owner and refuses a non-owner in an untrusted chat", async t => {
  const results: { isError?: boolean; content: { text: string }[] }[] = [];
  await run(t, "chat", [{ chat: "home", sender: owner }, { chat: "dm", sender: outsider }], async (_dispatch, tool) => {
    results.push(await tool().execute("call", { action: "list" }));
  });
  // The two chats' turns run concurrently, so match results by outcome.
  const [listed, refused] = [results.find(result => !result.isError)!, results.find(result => result.isError)!];
  const { threads } = JSON.parse(listed.content[0].text);
  assert.deepEqual(threads.map((thread: { chat_uid: string }) => thread.chat_uid), ["thread", "other", "started"]);
  assert.deepEqual(threads.find((thread: { chat_uid: string }) => thread.chat_uid === "thread"), {
    chat_uid: "thread", subject: "Booking", last_activity: "2026-09-28T12:00:00Z",
    participants: [{ name: "Owner", email: "owner@example.com", role: "owner" }, { name: "Sender", email: "sender@example.com", role: "member" }],
  });
  assert.match(refused.content[0].text, /owner's authority/);
});

test("a new thread whose send may have landed reports delivery unknown and is not resent", async t => {
  let receipt: Record<string, unknown> = {};
  const { posts } = await run(t, "chat", [{ chat: "home", sender: owner }], async (_dispatch, tool) => {
    const send = tool();
    receipt = JSON.parse((await send.execute("call", { to: ["new@example.com"], subject: "Hello", body: "Opening" })).content[0].text);
  }, { status: "error", chat_uid: null, http: 503 });
  assert.equal(receipt.success, false);
  assert.equal(receipt.delivery_unknown, true);
  assert.deepEqual(posts.map(post => post.path), ["/email-lines/mail/messages"]);
});

test("a reply sent to a thread from the owner's DM lands there and is recorded in the thread's session", async t => {
  let receipt: unknown;
  const { posts } = await run(t, "chat", [{ chat: "home", sender: owner }], async (_dispatch, tool) => {
    receipt = JSON.parse((await tool().execute("call", { to: "thread", body: "Thursday works." })).content[0].text);
  });
  assert.deepEqual(receipt, { sent: true, chat_uid: "thread" });
  assert.deepEqual(posts.map(post => post.path), ["/chats/thread/messages"]);
  assert.deepEqual(await transcript("agent:main:plow:email:direct:thread"), ["Thursday works."]);
});

test("the tool names the mailbox persona to sign as", () => {
  let description = "";
  toolEntry.register({ registrationMode: "full", runtime: {}, logger: { info() {} }, on() {}, registerChannel() {},
    registerTool(factory: (context: object) => { name: string; description: string }) {
      const tool = factory({ config: cfg });
      if (tool.name === "plow_send_email") description = tool.description;
    } });
  assert.match(description, /sign it as Elm, never as the owner/);
});

test("a thread's recorded origin that is no longer trusted gets nothing; the final goes to the owner's 1:1", async t => {
  const state = await mkdtemp(`${tmpdir()}/plow-email-state-`);
  t.after(() => { chats.group.trusted = true; return rm(state, { recursive: true }); });
  await run(t, "chat", [{ chat: "group", sender: owner }], async (_dispatch, tool) => {
    await tool().execute("call", { to: ["new@example.com"], subject: "Hello", body: "Opening" });
  }, undefined, state);
  chats.group.trusted = false;
  const { posts } = await run(t, "email", [{ chat: "started", sender: outsider }], async dispatch => { await final(dispatch, { text: "They replied yes." }); }, undefined, state);
  assert.deepEqual(posts.map(post => post.path), ["/chats/home/messages"]);
});

test("a thread's recorded origin the agent can no longer read falls back to the owner's 1:1", async t => {
  const state = await mkdtemp(`${tmpdir()}/plow-email-state-`);
  t.after(() => { forbidden.clear(); return rm(state, { recursive: true }); });
  await run(t, "chat", [{ chat: "group", sender: owner }], async (_dispatch, tool) => {
    await tool().execute("call", { to: ["new@example.com"], subject: "Hello", body: "Opening" });
  }, undefined, state);
  forbidden.add("group");
  const { posts, logs } = await run(t, "email", [{ chat: "started", sender: outsider }], async dispatch => { await final(dispatch, { text: "They replied yes." }); }, undefined, state);
  assert.deepEqual(posts.map(post => post.path), ["/chats/home/messages"]);
  assert.ok(logs.some(line => line.startsWith("completed chat=started")));
});

test("message with the email account selected is refused whatever the target", async t => {
  let refusal = "";
  const { posts } = await run(t, "chat", [{ chat: "home", sender: owner }], async (_dispatch, _tool, channel, config) => {
    await channel.outbound.sendText({ cfg: config, accountId: "email", to: "plow:home", text: "hi" }).catch((error: Error) => { refusal = error.message; });
  });
  assert.match(refusal, /plow_send_email/);
  assert.deepEqual(posts, []);
});
