import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

// plow-agents#83: a group text the agent was not invoked by is room activity it observes. Tagging its
// line, replying to its message or sending a command invokes it, so OpenClaw expects an answer there.
test("group texts are room events unless they tag the agent, reply to it or are a command", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const self = { type: "agent", relationship: "self", line: { uid: "line", display_name: "Cypress" } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Daniel", provider_key: "+15550000001" };
  const guest = { type: "member", uid: "guest", role: "member", display_name: "Ana", provider_key: "+15550000003" };
  const chat = { uid: "group", status: "active", trusted: true, participants: [self, owner, guest] };
  const nudge = { uid: "nudge", body: "Dinner at 8?", sender: self, direction: "outbound", attachments: [], created_at: "2026-10-23T21:00:00Z" };
  const inbound = (uid: string, sender: typeof owner, body: string, extra = {}) =>
    ({ uid, body, sender, direction: "inbound", attachments: [], created_at: `2026-10-23T21:0${uid.length % 9}:00Z`, ...extra });
  const messages = [
    inbound("plain", owner, "Oi amor, cheguei!"),
    inbound("tagged", guest, "Cypress, can you book it?", { mentions: [{ handle: "+15550000002", is_me: true }] }),
    inbound("reply", owner, "Yes, 8 works", { reply_to: { part_index: 0, message: nudge } }),
    inbound("command", owner, "/status"),
  ];
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
    url.includes("/messages?") ? { data: [nudge], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const message of messages) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } }));
  });
  const kinds: Record<string, string | undefined> = {};
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } };
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "group" }) },
      inbound: {
        buildContext: async (value: { messageId: string; message: { inboundEventKind?: string } }) => {
          kinds[value.messageId] = value.message.inboundEventKind;
          return {};
        },
        dispatch: async ({ replyOptions }: { replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
          replyOptions.onAgentRunTerminalOutcome("completed");
          if (Object.keys(kinds).length === messages.length) controller.abort();
          return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        },
      },
    } },
  });
  const cfg = { messages: { groupChat: { unmentionedInbound: "room_event" }, inbound: { byChannel: { plow: 0 } } } };
  await channel!.gateway.startAccount({ account: { apiBase, accountId: "chat", lineUid: "line" }, cfg, abortSignal: controller.signal, log: { info() {} } });
  assert.deepEqual(kinds, { plain: "room_event", tagged: "user_request", reply: "user_request", command: "user_request" });
});
