import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { listen, type Account, type Chat, type Message } from "../plugin/transport.ts";
import { websocketFixture } from "./ws-fixture.ts";

const sender = { type: "member" as const, uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
const chat: Chat = { uid: "home", status: "active", trusted: true, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
const inbound = (uid: string): Message => ({ uid, direction: "inbound", sender, body: uid, attachments: [], created_at: "2026-09-29T12:00:00Z" });
const frame = (message: Message) => JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat.uid, data: { message } });

for (const inclusive of [false, true]) test(`legacy checkpoints deduplicate buffered older frames before replay; inclusive=${inclusive}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, `${inclusive ? "first:" : ""}boundary`);
  const messages = [inbound("new"), inbound("boundary"), inbound("old")];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/chats")) {
      for (const socket of server.clients) {
        socket.send(frame(inbound("old")));
        socket.send(frame(inbound("boundary")));
        socket.send(frame(inbound("new")));
      }
      return Response.json({ data: [chat], has_more: false });
    }
    if (url.includes("/messages?")) {
      const after = new URL(url).searchParams.get("starting_after");
      return Response.json({ data: after ? messages.slice(messages.findIndex(message => message.uid === after) + 1) : messages, has_more: false });
    }
    return Response.json(url.endsWith("/chats/home") ? chat : { ticket: "ticket" });
  });
  const turns: string[] = [];
  const account: Account = { apiBase, accountId: "chat", lineUid: "line" };
  await listen(account, abortAfter().signal, () => {}, async (_chat, message) => {
    turns.push(message.uid);
    return "completed";
  });
  assert.deepEqual(turns, inclusive ? ["boundary", "new"] : ["new"]);
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
  assert.ok(saved.recent.includes("old"));
  await listen(account, abortAfter().signal, () => {}, async (_chat, message) => {
    turns.push(message.uid);
    return "completed";
  });
  assert.deepEqual(turns, inclusive ? ["boundary", "new"] : ["new"]);
});
// The inbound clock lags the outbound clock; HTTP history orders them by timestamp.
test("a late frame older than the checkpoint is deduplicated across restart", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, "outbound");
  const outbound: Message = { ...inbound("outbound"), direction: "outbound", sender: chat.participants[1] };
  const messages = [outbound, inbound("old")];
  const recovered = Promise.withResolvers<void>();
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/messages?") && ++historyReads === 1) recovered.resolve();
    return Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/home") ? chat :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : messages, has_more: false } : { ticket: "ticket" });
  });
  const controller = abortAfter();
  const turns: string[] = [];
  const fixture: Account = { apiBase, accountId: "chat", lineUid: "line" };
  const running = listen(fixture, controller.signal, text => {
    if (text.startsWith("acked chat=home message=late")) controller.abort();
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
