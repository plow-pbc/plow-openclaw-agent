import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { listen, type Account, type Chat, type Message } from "../plugin/transport.ts";
import { websocketFixture } from "./ws-fixture.ts";

const sender = { type: "member" as const, uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
const chat: Chat = { uid: "home", status: "active", trusted: true, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
const inbound = (uid: string): Message => ({ uid, direction: "inbound", sender, body: uid, attachments: [], created_at: "2026-09-29T12:00:00Z" });
const frame = (message: Message) => JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat.uid, data: { message } });
// The inbound clock lags the outbound clock; HTTP history orders them by timestamp.
test("catch-up overlaps the checkpoint and deduplicates a late older inbound across restart", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, "outbound");
  const outbound: Message = { ...inbound("outbound"), direction: "outbound", sender: chat.participants[1] };
  const messages = [outbound, inbound("old")];
  const recovered = Promise.withResolvers<void>();
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/messages?") && ++historyReads === 2) recovered.resolve();
    return Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/home") ? chat :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : messages, has_more: false } : { ticket: "ticket" });
  });
  const controller = abortAfter();
  const turns: string[] = [];
  const fixture: Account = { apiBase, accountId: "chat", lineUid: "line" };
  const running = listen(fixture, controller.signal, text => {
    if (text === "acked chat=home message=late") controller.abort();
  }, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  await recovered.promise;
  const late = { ...inbound("late"), created_at: "2026-09-29T11:59:59Z" };
  messages.splice(1, 0, late);
  for (const socket of server.clients) socket.send(frame(late));
  await running;
  assert.deepEqual(turns, ["late"]);
  await listen(fixture, abortAfter(200).signal, () => {}, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  assert.deepEqual(turns, ["late"]);
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
  }, async (_chat, message) => {
    bodies.push(message.body);
    return "completed";
  }, { messages: { inbound: { byChannel: { plow: 100 } } } });
  assert.deepEqual(bodies, ["first second third", "/status", "fourth fifth sixth"]);
  for (const uid of ["first", "second", "third", "/status", "fourth", "fifth", "sixth"]) {
    assert.equal(acks.filter(text => text === `acked chat=home message=${uid}`).length, 1);
  }
});
