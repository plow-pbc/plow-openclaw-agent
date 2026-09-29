import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { listen, type Account, type Chat, type Message } from "../plugin/transport.ts";
import { websocketFixture } from "./ws-fixture.ts";

const sender = { type: "member" as const, uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
const chat: Chat = { uid: "home", status: "active", trusted: true, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
const inbound = (uid: string): Message => ({ uid, direction: "inbound", sender, body: uid, attachments: [], created_at: "2026-09-29T12:00:00Z" });
const frame = (message: Message) => JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat.uid, data: { message } });
type Lifecycle = { onAdopted: () => Promise<void>; onDeferred: () => boolean; onAbandoned: () => void; onSettled?: () => void; abortSignal: AbortSignal };

// The inbound clock lags the outbound clock; HTTP history orders them by timestamp.
test("catch-up overlaps the checkpoint and deduplicates a late older inbound across restart", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, "outbound");
  const outbound: Message = { ...inbound("outbound"), direction: "outbound", sender: chat.participants[1] };
  const messages = [outbound, inbound("old")];
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/home") ? chat :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : messages, has_more: false } : { ticket: "ticket" }));
  const controller = abortAfter();
  const turns: string[] = [];
  const fixture: Account = { apiBase, accountId: "chat", lineUid: "line" };
  const running = listen(fixture, controller.signal, text => {
    if (text === "acked chat=home message=late") controller.abort();
  }, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  while (!(await readFile(`${root}/plow-checkpoints/home`, "utf8")).includes("old") && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
  const late = { ...inbound("late"), created_at: "2026-09-29T11:59:59Z" };
  messages.splice(1, 0, late);
  for (const socket of server.clients) socket.send(frame(late));
  await running;
  assert.deepEqual(turns, ["late"]);
  await listen(fixture, abortAfter(200).signal, () => {}, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  assert.deepEqual(turns, ["late"]);
});

test("adoption releases inbound bursts while preserving the running tool context and typing", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const cfg = { channels: { plow: { ...account, threadTrust: "trusted" } } };
  const messages: Message[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (options?.method === "POST" && options.body) posts.push({ path: new URL(url).pathname, body: JSON.parse(options.body as string) });
    return Response.json(url.endsWith("/chats") && options?.method === "GET" ? { data: [chat], has_more: false } :
      url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : messages, has_more: false } : { ticket: "ticket", uid: "created" });
  });
  const first = inbound("first"), second = inbound("second"), third = inbound("third");
  const released = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => released.resolve());
  let tool: { execute: (id: string, args: object) => Promise<unknown> };
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } };
  const toolScope = new AsyncResource("host-tool-execution");
  const toolEntry = (await import(new URL("../plugin/index.ts?queue-tools", import.meta.url).href)).default as typeof entry;
  const turns: string[] = [], logs: string[] = [];
  let toolSucceeded = false;
  const api = { registrationMode: "full", logger: { info() {} }, on() {}, registerTool() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: { routing: { resolveAgentRoute: () => ({ sessionKey: "agent:main:main" }) }, inbound: {
      buildContext: async (value: { messageId: string }) => value,
      dispatch: async ({ ctxPayload, replyOptions, dispatcherOptions }: { ctxPayload: { messageId: string }; replyOptions: { turnAdoptionLifecycle: Lifecycle; onAgentRunStart: (id: string) => void; onAgentRunTerminalOutcome: (outcome: string) => void }; dispatcherOptions: { typingCallbacks: { onReplyStart: () => Promise<void>; onIdle: () => void } } }) => {
        const uid = ctxPayload.messageId;
        turns.push(uid);
        if (uid !== "first") replyOptions.turnAdoptionLifecycle.onDeferred();
        if (uid === "first") { replyOptions.onAgentRunStart("run-first"); await dispatcherOptions.typingCallbacks.onReplyStart(); }
        await replyOptions.turnAdoptionLifecycle.onAdopted();
        if (uid === "first") {
          messages.unshift(third, second);
          for (const socket of server.clients) { socket.send(frame(third)); socket.send(frame(second)); }
          await released.promise;
        } else if (uid === "third") {
          assert.equal(posts.filter(post => post.path.endsWith("/typing") && post.body.action === "stop").length, 0);
          const result = await toolScope.runInAsyncScope(() => tool.execute("start", { members: ["+15550000002"], body: "Hello" }));
          assert.deepEqual((result as { details: unknown }).details, { chat_uid: "created", message_sent: true });
          toolSucceeded = true;
          released.resolve();
        }
        if (uid === "first") { dispatcherOptions.typingCallbacks.onIdle(); replyOptions.onAgentRunTerminalOutcome("completed"); }
        return { dispatched: true, dispatchResult: uid === "first" ? { deliberateSilentTerminalReply: true } : { deferredToActiveRun: "steer" } };
      },
    } } },
  };
  entry.register(api);
  toolEntry.register({ ...api, registerChannel() {}, registerTool(factory: (context: object) => { name: string; execute: typeof tool.execute }) {
    const candidate = factory({ config: cfg, sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "home" });
    if (candidate.name === "plow_start_thread") tool = candidate;
  } });
  server.on("connection", socket => { messages.unshift(first); socket.send(frame(first)); });
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(text: string) {
    logs.push(text);
    if (text === "completed chat=home message=first") controller.abort();
  } } });
  assert.deepEqual(turns, ["first", "second", "third"]);
  assert.equal(toolSucceeded, true);
  for (const uid of turns) assert.equal(logs.filter(text => text === `acked chat=home message=${uid}`).length, 1);
  assert.equal(posts.filter(post => post.path.endsWith("/typing") && post.body.action === "start").length, 1);
  assert.equal(posts.filter(post => post.path.endsWith("/typing") && post.body.action === "stop").length, 1);
});

test("same-sender text batches flush before status and acknowledge every source once", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(3000);
  const messages: Message[] = [];
  const bodies: string[] = [], acks: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : messages, has_more: false } : { ticket: "ticket" }));
  server.on("connection", socket => {
    const first = inbound("first"); messages.unshift(first); socket.send(frame(first));
    setTimeout(() => {
      assert.deepEqual(bodies, [], "first text waits for the same-sender debounce window");
      for (const uid of ["second", "third", "/status", "fourth", "fifth", "sixth"]) {
        const message = inbound(uid); messages.unshift(message); socket.send(frame(message));
      }
    }, 20);
  });
  await listen({ apiBase, accountId: "chat", lineUid: "line" }, controller.signal, text => {
    if (text.startsWith("acked ")) acks.push(text);
    if (text === "acked chat=home message=sixth") controller.abort();
  }, async (_chat, message, _firstContact, _history, adoption) => {
    bodies.push(message.body);
    await adoption.onAdopted();
    return "completed";
  }, { messages: { inbound: { byChannel: { plow: 100 } } } });
  assert.deepEqual(bodies, ["first second third", "/status", "fourth fifth sixth"]);
  for (const uid of ["first", "second", "third", "/status", "fourth", "fifth", "sixth"]) {
    assert.equal(acks.filter(text => text === `acked chat=home message=${uid}`).length, 1);
  }
});

test("an adoption checkpoint failure retries the source after reconnect", { timeout: 40_000 }, async t => {
  const { root, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(35_000);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, JSON.stringify({ uid: "old", recent: ["old"] }));
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : [inbound("first"), inbound("old")], has_more: false } : { ticket: "ticket" }));
  const writer = t.mock.method(fs, "writeFile", async () => { throw new Error("disk failure"); });
  syncBuiltinESMExports();
  t.after(() => { writer.mock.restore(); syncBuiltinESMExports(); });
  const calls: string[] = [], acks: string[] = [];
  await listen({ apiBase, accountId: "chat", lineUid: "line" }, controller.signal, text => {
    if (text.startsWith("transport stopped")) { writer.mock.restore(); syncBuiltinESMExports(); }
    if (text === "acked chat=home message=first") { acks.push(text); controller.abort(); }
  }, async (_chat, message, _firstContact, _history, adoption) => {
    calls.push(message.uid);
    await adoption.onAdopted();
    return "completed";
  });
  assert.deepEqual(calls, ["first", "first"]);
  assert.equal(acks.length, 1);
  assert.equal(JSON.parse(await readFile(`${root}/plow-checkpoints/home`, "utf8")).uid, "first");
});
