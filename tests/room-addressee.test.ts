import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { renderConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";
import { websocketFixture } from "./ws-fixture.ts";

// plow-openclaw-agent#123: in Daniel's group, "amor, don't forget to grab milk on the way home" (to the partner)
// got "🥛" from the agent. A room event that calls someone else gets no tool that posts or reacts.
const POSTING = ["message", "plow_reply_to", "plow_start_thread", "plow_send_email"];
type Policy = { allow?: string[]; deny?: string[] } | undefined;
const cases: { name: string; body: string; kind?: "group" | "direct"; role?: "owner" | "member"; guestTools?: string[]; tagged?: boolean;
  event: string; policy: Policy; disabled?: true }[] = [
  { name: "owner's chore for the partner", body: "amor, don't forget to grab milk on the way home", event: "room_event", policy: { deny: POSTING } },
  { name: "owner calls the partner by name", body: "Camily, did you book the dentist?", event: "room_event", policy: { deny: POSTING } },
  { name: "owner names the agent", body: "Probe, what's today's date?", event: "room_event", policy: undefined },
  { name: "ambiguous ask to the room", body: "Anyone know a good pizza place?", event: "room_event", policy: undefined },
  { name: "a tag makes it a request, pet name or not", body: "amor, don't forget to grab milk", tagged: true, event: "user_request", policy: undefined },
  { name: "a 1:1 chat is never a room event", body: "amor, don't forget to grab milk", kind: "direct", event: "user_request", policy: undefined },
  { name: "guest with guest tools keeps them, without message", body: "Oi amor, cheguei!", role: "member", guestTools: ["guest_view"], event: "room_event", policy: { allow: ["guest_view"] } },
  { name: "guest with no guest tools gets none", body: "Oi amor, cheguei!", role: "member", guestTools: [], event: "room_event", policy: undefined, disabled: true },
  { name: "guest's ambiguous ask keeps the message tool", body: "Anyone know a good pizza place?", role: "member", guestTools: [], event: "room_event", policy: { allow: ["message"] } },
];
for (const c of cases) test(`room event addressee: ${c.name}`, async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const previous = process.env.PLOW_GUEST_TOOLS;
  process.env.PLOW_GUEST_TOOLS = (c.guestTools ?? []).join(",");
  t.after(() => { if (previous === undefined) delete process.env.PLOW_GUEST_TOOLS; else process.env.PLOW_GUEST_TOOLS = previous; });
  const cfg = renderConfig(probeIdentity, apiBase);
  cfg.messages.inbound.byChannel.plow = 0;
  const account = { ...cfg.channels.plow, apiBase, accountId: "chat", lineUid: "line" };
  const role = c.role ?? "owner";
  const sender = { type: "member", uid: "sender", role, display_name: "Daniel", provider_key: "+15550000001" };
  const partner = { type: "member", uid: "partner", role: "member", display_name: "+15550000002", provider_key: "+15550000002" };
  const agent = { type: "agent", relationship: "self", line: { uid: "line" } };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [sender, agent, ...(c.kind === "direct" ? [] : [partner])] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: "chat",
    data: { message: { uid: "inbound", direction: "inbound", sender, body: c.body, attachments: [], created_at: new Date().toISOString(),
      ...(c.tagged ? { mentions: [{ handle: "+15550000009", is_me: true }] } : {}) } } })));
  let context: { access?: { toolPolicy?: Policy }; message: { inboundEventKind?: string } } | undefined;
  let disabled: boolean | undefined;
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", on() {}, registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "unchanged" }) },
      inbound: { buildContext: async (value: typeof context) => { context = value; return value; },
        dispatch: async ({ replyOptions }: { replyOptions: { disableTools?: boolean } }) => {
          disabled = replyOptions.disableTools;
          controller.abort(); return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
        } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  assert.ok(context);
  assert.equal(context.message.inboundEventKind, c.event);
  assert.deepEqual(context.access?.toolPolicy, c.policy);
  assert.equal(disabled, c.disabled);
});
