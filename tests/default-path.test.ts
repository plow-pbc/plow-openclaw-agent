import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { listen, type Account, type TurnIngress } from "../plugin/transport.ts";
import { websocketFixture } from "./ws-fixture.ts";
import entry from "../plugin/index.ts";

test("same-chat slow preparation preserves dispatch order without waiting for the first run", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const sender = { type: "member", uid: "member", role: "member", provider_key: "+15550000001" };
  const chat = { uid: "chat", status: "active", trusted: true, participants: [sender,
    { type: "agent", relationship: "self", line: { uid: "line" } }] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", socket => {
    for (const uid of ["first", "second"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid,
      chat_id: chat.uid, data: { message: { uid, direction: "inbound", sender, body: uid, attachments: [], created_at: new Date().toISOString() } } }));
  });
  const secondDispatched = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => secondDispatched.resolve());
  const dispatched: string[] = [], acks: string[] = [];
  let startAccount: (context: object) => Promise<void>;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} },
    registerChannel({ plugin }: { plugin: { gateway: { startAccount: typeof startAccount } } }) { startAccount = plugin.gateway.startAccount; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "main" }) },
      inbound: {
        buildContext: async ({ messageId }: { messageId: string }) => {
          if (messageId === "first") await new Promise(resolve => setTimeout(resolve, 100));
          return { MessageSid: messageId };
        },
        dispatch: async ({ ctxPayload }: { ctxPayload: { MessageSid: string } }) => {
          dispatched.push(ctxPayload.MessageSid);
          if (ctxPayload.MessageSid === "first") await secondDispatched.promise;
          else secondDispatched.resolve();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      },
    } },
  });
  await startAccount!({ account: { apiBase, accountId: "chat", lineUid: "line" }, cfg: {}, abortSignal: controller.signal,
    log: { info(text: string) { if (text.startsWith("acked chat=chat message=")) { acks.push(text); if (acks.length === 2) controller.abort(); } } } });
  assert.deepEqual(dispatched, ["first", "second"]);
  assert.equal(acks.length, 2);
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
});

test("a deferred source stays pending across a WebSocket reconnect until adoption", { timeout: 45_000 }, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(40_000);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, "old");
  const sender = { type: "member", uid: "owner", role: "owner" } as const;
  const chat = { uid: "home", status: "active", trusted: true, participants: [sender,
    { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const message = (uid: string) => ({ uid, direction: "inbound", sender, body: uid, attachments: [], created_at: new Date().toISOString() });
  let connections = 0;
  server.on("connection", () => { connections++; });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/home") ? chat :
    url.includes("limit=50") ? { data: [...(connections > 1 ? [message("later")] : []), message("deferred"),
      { ...message("old"), direction: "outbound" }], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const seen: string[] = [], acks: string[] = [];
  let deferred: TurnIngress | undefined;
  await listen({ apiBase, accountId: "chat", lineUid: "line" } as Account, controller.signal, text => {
    if (text.startsWith("acked chat=home") && text.includes(" stage=adoption")) acks.push(text);
    if (text.startsWith("acked chat=home message=later ")) controller.abort();
  }, async (_chat, message, _first, _history, ingress) => {
    seen.push(message.uid);
    if (message.uid === "deferred") {
      deferred ??= ingress;
      if (connections === 1) for (const socket of server.clients) socket.terminate();
      return "deferred";
    }
    assert.deepEqual(acks, []);
    assert.ok(deferred);
    await deferred.onAdopted();
    await ingress.onAdopted();
    return "completed";
  });
  assert.equal(connections, 2);
  assert.deepEqual(seen, ["deferred", "later"]);
  assert.equal(acks.length, 2);
  for (const uid of ["deferred", "later"]) assert.equal(acks.filter(text => text.startsWith(`acked chat=home message=${uid} `)).length, 1);
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
  assert.equal(saved.uid, "later");
  assert.ok(saved.recent.includes("deferred"));
});
