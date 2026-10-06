import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  // Immediate inputs must flush the burst before the 6s guard, despite a 30s debounce.
  await channel!.gateway.startAccount({ account: { apiBase, accountId: "chat", lineUid: "line" }, cfg: { messages: { inbound: { byChannel: { plow: scenario === "slash" || scenario === "media" ? 30_000 : 300 } } } }, abortSignal: controller.signal, log: { info() {} } });
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
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/chat`, "utf8"));
  assert.deepEqual(saved.recent, sourceIds);
  assert.equal(saved.uid, sourceIds.at(-1));
});

for (const firstContact of [false, true]) test(`WS arrival debounces slow chat and owner-history reads once per burst: firstContact=${firstContact}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(12_000);
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const chat = { uid: "chat", status: "active", trusted: true, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const first = { uid: "first", direction: "inbound", sender, body: "pitch him this:", attachments: [], created_at: new Date().toISOString() };
  const second = { ...first, uid: "second", body: "https://notion.so/example" };
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, JSON.stringify({ uid: firstContact ? "first:first" : "baseline", recent: firstContact ? [] : ["baseline"] }));
  const recovered = Promise.withResolvers<void>();
  let chatReads = 0, historyReads = 0;
  const historyUrls: string[] = [];
  const phases: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    const path = String(url);
    if (path.endsWith("/chats/chat")) { phases.push("chat read"); await delay(700 * ++chatReads); return Response.json(chat); }
    if (path.includes("limit=20")) {
      phases.push("history read");
      historyUrls.push(path);
      await delay(700 * ++historyReads);
      return Response.json({ data: [], has_more: false });
    }
    if (path.includes("limit=50")) recovered.resolve();
    return Response.json(path.endsWith("/chats") ? { data: [chat], has_more: false } : path.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", socket => {
    void recovered.promise.then(async () => {
      const send = (message: typeof first) => socket.send(JSON.stringify({ event_type: "message_received", chat_id: chat.uid, data: { message } }));
      send(first);
      await delay(1500);
      send(second);
      send(second);
    });
  });
  const contexts: { messageId: string; message: { rawBody: string }; supplemental: { channelStructuredContext: { payload: { first_contact: boolean } }[] } }[] = [];
  const logs: string[] = [];
  let channel: { gateway: { startAccount: (ctx: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) },
      inbound: {
        buildContext: async (context: typeof contexts[number]) => { contexts.push(context); return context; },
        dispatch: async ({ replyOptions }: { replyOptions: { turnAdoptionLifecycle: { onAdopted: () => Promise<void> } } }) => {
          await replyOptions.turnAdoptionLifecycle.onAdopted();
          if (contexts.at(-1)!.message.rawBody.includes(second.body) || contexts.length === 2) controller.abort();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      },
    } },
  });
  await channel!.gateway.startAccount({ account: { apiBase, accountId: "chat", lineUid: "line" }, cfg: { messages: { inbound: { byChannel: { plow: 2000 } } } }, abortSignal: controller.signal, log: { info: (line: string) => { logs.push(line); if (line.startsWith("buffered ")) phases.push("buffered"); } } });
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
  assert.deepEqual(contexts.map(context => context.message.rawBody), [`${first.body}\n${second.body}`]);
  assert.equal(contexts[0].messageId, second.uid);
  assert.equal(contexts[0].supplemental.channelStructuredContext[0].payload.first_contact, firstContact);
  assert.deepEqual(phases, ["buffered", "buffered", "chat read", "history read"]);
  assert.equal(chatReads, 1);
  assert.equal(historyReads, 1);
  assert.deepEqual(historyUrls, [`${apiBase}/v1/chats/chat/messages?limit=20&starting_after=first`]);
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/chat`, "utf8"));
  assert.deepEqual(saved.recent, [...(firstContact ? [] : ["baseline"]), "first", "second"]);
  assert.equal(saved.uid, "second");
  const buffered = logs.filter(line => line.startsWith("buffered "));
  assert.equal(buffered.length, 2);
  assert.ok(buffered.every(line => line.includes("chat=chat") && line.includes("sender=chat/chat/owner") && /timestamp=\d+/.test(line)));
  assert.ok(buffered[0].includes("message=first") && buffered[1].includes("message=second"));
  assert.ok(buffered.every(line => !line.includes(first.body) && !line.includes(second.body)));
});
