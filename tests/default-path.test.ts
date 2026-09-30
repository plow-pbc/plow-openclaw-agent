import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { listen, type Account, type Chat, type Message, type TurnIngress } from "../plugin/transport.ts";
import { websocketFixture } from "./ws-fixture.ts";

test("immediate dispatch checkpoints deferred sources only on adoption", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, JSON.stringify({ uid: "", recent: [] }));
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" } as const;
  const chat: Chat = { uid: "home", status: "active", trusted: true, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const messages: Message[] = ["first", "second"].map(uid => ({ uid, body: uid, direction: "inbound", sender, attachments: [], created_at: new Date().toISOString() }));
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url.endsWith("/chats") ? { data: [], has_more: false } : url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", socket => {
    for (const message of messages) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: "home", data: { message } }));
  });
  const seen: string[] = [], acks: string[] = [];
  let first: TurnIngress | undefined;
  await listen({ apiBase, accountId: "chat", lineUid: "line" } as Account, controller.signal, text => {
    if (text.startsWith("acked chat=home")) acks.push(text);
    if (text.includes("message=second stage=adoption")) controller.abort();
  }, async (_chat, message, _firstContact, _history, ingress) => {
    seen.push(message.body);
    assert.ok(ingress);
    if (message.uid === "first") { first = ingress; return "deferred"; }
    assert.deepEqual(acks, []);
    assert.ok(first);
    await first.onAdopted();
    await ingress.onAdopted();
    return "completed";
  });
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(acks.length, 2);
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
  assert.deepEqual(saved.recent, ["first", "second"]);
});
