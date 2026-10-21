import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

test("inbound attachments: Plow's 100 MiB cap, and media Plow marked failed is named instead of failing the turn", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [owner, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const photo = "/v1/chats/chat/attachments/att_photo/content?exp=1&sig=s";
  const message = { uid: "inbound", direction: "inbound", sender: owner, body: "the leak, and a photo of it", created_at: new Date().toISOString(), attachments: [
    { url: null, content_type: "video/quicktime", filename: "IMG_0412.MOV" },
    { url: photo, content_type: "image/jpeg", filename: "IMG_0413.JPG" },
  ] };
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    fetched.push(String(url));
    const path = String(url);
    return path.endsWith(photo) ? new Response("jpeg bytes") : path.endsWith("/ws/ticket") ? Response.json({ ticket: "ticket" })
      : path.endsWith("/chats") ? Response.json({ data: [chat], has_more: false }) : path.endsWith("/chats/chat") ? Response.json(chat)
      : path.includes("/messages?") ? Response.json({ data: [], has_more: false }) : new Response("", { status: 404 });
  });
  server.on("connection", socket => socket.send(JSON.stringify({ event_type: "message_received", chat_id: "chat", data: { message } })));
  const saves: unknown[][] = [];
  let context: { message: { rawBody: string }; media: { path: string; fileName: string }[] } | undefined;
  let channel: { gateway: { startAccount: (ctx: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) },
      media: { saveMediaBuffer: async (...args: unknown[]) => { saves.push(args); return { path: "/media/IMG_0413.jpg" }; } },
      inbound: {
        buildContext: async (value: typeof context) => { context = value; return value; },
        dispatch: async ({ replyOptions }: { replyOptions: { turnAdoptionLifecycle: { onAdopted: () => Promise<void> } } }) => {
          await replyOptions.turnAdoptionLifecycle.onAdopted();
          controller.abort();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      },
    } },
  });
  await channel!.gateway.startAccount({ account: { apiBase, accountId: "chat", lineUid: "line" }, cfg: {}, abortSignal: controller.signal, log: { info() {} } });
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
  assert.ok(context, "the turn ran");
  assert.equal(context.message.rawBody, "the leak, and a photo of it\n[Attachment not available: IMG_0412.MOV]");
  assert.deepEqual(context.media.map(m => m.path), ["/media/IMG_0413.jpg"]);
  // OpenClaw's 5 MB default failed the turn on an ordinary photo; Plow serves up to 100 MiB.
  assert.deepEqual(saves.map(([, contentType, subdir, maxBytes, filename]) => [contentType, subdir, maxBytes, filename]),
    [["image/jpeg", "inbound", 100 * 1024 * 1024, "IMG_0413.JPG"]]);
  assert.ok(!fetched.some(url => url.endsWith("/null")), "nothing fetched for the failed video");
});
