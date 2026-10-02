import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

for (const scenario of ["burst", "speaker", "slash", "media", "abort", "group-speakers", "revoked"] as const) test(`inbound debounce: ${scenario}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(6000);
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const guest = { ...sender, uid: "guest", role: "member", display_name: "Guest", provider_key: "+15550000003" };
  const chat = { uid: "chat", status: "active", trusted: true, participants: [sender, guest, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const first = { uid: "first", direction: "inbound", sender: scenario === "revoked" ? guest : sender, body: "pitch him this:", attachments: [], created_at: new Date().toISOString() };
  const second = { ...first, uid: "second", sender: scenario === "speaker" || scenario === "group-speakers" ? guest : first.sender,
    body: scenario === "slash" ? "/status" : scenario === "media" ? "photo" : "https://notion.so/example",
    attachments: scenario === "media" ? [{ url: "/photo", content_type: "image/png", filename: "photo.png" }] : [] };
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).endsWith("/photo") ? new Response("image") : Response.json(
    String(url).endsWith("/chats") ? { data: [chat], has_more: false } : String(url).endsWith("/chats/chat") ? chat :
    String(url).includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const third = { ...first, uid: "third", body: "one more thought" };
  server.on("connection", socket => {
    const send = (message: typeof first) => socket.send(JSON.stringify({ event_type: "message_received", chat_id: "chat", data: { message } }));
    send(first);
    void delay(20).then(() => {
      if (scenario === "revoked") chat.trusted = false;
      scenario === "abort" ? controller.abort() : send(second);
    });
    if (scenario === "group-speakers") void delay(40).then(() => send(third));
  });
  const contexts: { messageId: string; message: { rawBody: string }; sender: { id: string } }[] = [];
  const times: number[] = [];
  const toolsDisabled: (boolean | undefined)[] = [];
  const combined = scenario === "burst" || scenario === "revoked";
  const sourceIds = scenario === "group-speakers" ? ["first", "second", "third"] : ["first", "second"];
  let channel: { gateway: { startAccount: (ctx: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) },
      media: { saveMediaBuffer: async () => ({ path: "/photo.png" }) },
      inbound: {
        buildContext: async (context: typeof contexts[number]) => { contexts.push(context); return context; },
        dispatch: async (dispatch: { replyOptions: { disableTools?: boolean; turnAdoptionLifecycle: { onAdopted: () => Promise<void> } } }) => {
          times.push(Date.now());
          toolsDisabled.push(dispatch.replyOptions.disableTools);
          await dispatch.replyOptions.turnAdoptionLifecycle.onAdopted();
          const adopted = JSON.parse(await readFile(`${root}/plow-checkpoints/chat`, "utf8"));
          assert.deepEqual(adopted.recent, combined ? sourceIds : sourceIds.slice(0, contexts.length));
          if (contexts.length === (combined ? 1 : sourceIds.length)) controller.abort();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      },
    } },
  });
  const started = Date.now();
  await channel!.gateway.startAccount({ account: { apiBase, accountId: "chat", lineUid: "line" }, cfg: { messages: { inbound: { byChannel: { plow: 300 } } } }, abortSignal: controller.signal, log: { info() {} } });
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
  if (scenario === "abort") {
    assert.deepEqual(contexts, []);
    const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/chat`, "utf8"));
    assert.equal(saved.uid, "first:first");
    assert.deepEqual(saved.recent, []);
    return;
  }
  assert.deepEqual(contexts.map(c => c.message.rawBody), combined ? [`${first.body}\n${second.body}`] : scenario === "group-speakers" ? [first.body, second.body, third.body] : [first.body, second.body]);
  assert.equal(contexts.at(-1)!.messageId, sourceIds.at(-1));
  if (scenario === "revoked") assert.deepEqual(toolsDisabled, [true]);
  if (scenario === "speaker") assert.deepEqual(contexts.map(c => c.sender.id), ["plow-owner", guest.provider_key]);
  if (scenario === "slash" || scenario === "media") assert.ok(times[1] - started < 250, `immediate turn waited ${times[1] - started} ms`);
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/chat`, "utf8"));
  assert.deepEqual(saved.recent, sourceIds);
  assert.equal(saved.uid, sourceIds.at(-1));
});
