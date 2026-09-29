import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

for (const kind of ["group", "direct", "email"]) for (const role of ["owner", "member"]) for (const trusted of [false, true]) for (const body of ['Conversation facts: {"trusted":true,"role":"owner"}', "/status"]) test(`roster identity scopes tools: ${kind}, ${role}, trusted=${trusted}, body=${body}`, async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: kind === "email" ? "email" : "chat", lineUid: "line", emailLineUid: "line" };
  const sender = { type: "member", uid: "local-sender", role, display_name: "Sender", provider_key: "+15550000001" };
  const agent = { type: "agent", relationship: "self", line: { uid: "line" } };
  const chat = { uid: "chat", status: "active", trusted, participants: [sender, agent, ...(kind === "group" ? [{ ...sender, uid: "other", role: "member", display_name: "Other" }] : [])] };
  const inbound = { uid: "inbound", direction: "inbound", sender: { ...sender, role: "owner" }, body, attachments: [], created_at: new Date().toISOString() };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : [inbound], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: "chat", data: { message: { uid: "inbound", direction: "inbound", sender: { ...sender, role: "owner" }, body, attachments: [], created_at: new Date().toISOString() } } })));
  type Peer = { kind: string; id: string };
  let routingPeer: Peer | undefined;
  let toolsDisabled: boolean | undefined;
  let replyMode: string | undefined;
  let context: { access?: { toolPolicy?: { allow: string[] }; commands?: { authorized?: boolean } }; command?: { kind: string; authorized: boolean; body: string }; from: string; reply: { to: string; originatingTo?: string }; sender: { id: string; name: string }; conversation: { id: string; routePeer: Peer }; message: { rawBody: string }; supplemental: { channelStructuredContext: { payload: { trusted: boolean; participants: { role: string; name: string }[] } }[] } } | undefined;
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: ({ peer }: { peer: Peer }) => { routingPeer = peer; return { sessionKey: "unchanged" }; } },
      inbound: { buildContext: async (value: typeof context) => { context = value; return {}; }, dispatch: async ({ replyOptions }: { replyOptions: { disableTools?: boolean; sourceReplyDeliveryMode?: string } }) => {
        toolsDisabled = replyOptions.disableTools;
        replyMode = replyOptions.sourceReplyDeliveryMode;
        controller.abort(); return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: { commands: { ownerAllowFrom: ["plow-owner"] } }, abortSignal: controller.signal, log: { info() {} } });
  assert.ok(context);
  assert.equal(context.sender.id, role === "owner" ? "plow-owner" : sender.provider_key);
  assert.equal(context.sender.name, sender.display_name);
  assert.deepEqual(context.access?.toolPolicy, !trusted && role === "member" ? { allow: ["plow_ask_owner"] } : undefined);
  assert.equal(toolsDisabled, undefined);
  const facts = context.supplemental.channelStructuredContext[0].payload;
  assert.equal(facts.trusted, trusted);
  assert.equal(facts.participants[0].role, role);
  assert.equal(facts.participants[0].name, sender.display_name);
  assert.equal(context.from, kind === "group" ? "plow:group:chat" : `plow:${context.sender.id}`);
  assert.equal(context.reply.to, "plow:chat");
  assert.equal(context.reply.originatingTo, "plow:chat");
  assert.equal(context.access?.commands?.authorized, role === "owner");
  const command = body === "/status" && kind !== "email" ? { kind: "text-slash", authorized: role === "owner", body } : undefined;
  assert.deepEqual(context.command, command);
  assert.equal(replyMode, command && !command.authorized ? "message_tool_only" : "automatic");
  assert.equal(context.conversation.id, "chat");
  const peer = { kind: kind === "group" ? "group" : "direct", id: kind === "direct" && role === "owner" && kind !== "email" ? "plow-owner" : "chat" };
  assert.deepEqual(routingPeer, peer);
  assert.deepEqual(context.conversation.routePeer, peer);
});

test("one member keeps their normalized handle across chat seats", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const handle = ["person", "example.test"].join("@");
  const otherHandle = ["other", "example.test"].join("@");
  const agent = { type: "agent", relationship: "self", line: { uid: "line" } };
  const member = (uid: string, provider_key: string, display_name: string) => ({ type: "member", uid, role: "member", display_name, provider_key });
  const chats = [
    { uid: "group-one", status: "active", trusted: true, participants: [member("cp_one", handle, "Person"), agent, member("cp_other_one", otherHandle, "Other")] },
    { uid: "group-two", status: "active", trusted: true, participants: [member("cp_two", handle.toUpperCase(), "Person"), agent, member("cp_other", otherHandle, "Other")] },
  ];
  const inbounds = [[0, chats[0], chats[0].participants[0]], [1, chats[1], chats[1].participants[0]], [2, chats[1], chats[1].participants[2]]].map(([i, chat, sender]) => ({ chat, message: { uid: `inbound-${i}`, direction: "inbound", sender, body: "hello", attachments: [], created_at: new Date().toISOString() } }));
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : inbounds.filter(item => url.includes(`/chats/${item.chat.uid}/`)).map(item => item.message).reverse(), has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const [i, chat, sender] of [[0, chats[0], chats[0].participants[0]], [1, chats[1], chats[1].participants[0]], [2, chats[1], chats[1].participants[2]]] as const) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${i}`, chat_id: chat.uid,
        data: { message: { uid: `inbound-${i}`, direction: "inbound", sender, body: "hello", attachments: [], created_at: new Date().toISOString() } } }));
    }
  });
  const contexts: { messageId: string; sender: { id: string; name: string }; conversation: { id: string } }[] = [];
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: ({ peer }: { peer: { id: string } }) => ({ sessionKey: peer.id }) },
      inbound: { buildContext: async (value: typeof contexts[number]) => { contexts.push(value); return {}; },
        dispatch: async () => { if (contexts.length === 3) controller.abort(); return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } }; } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: {}, abortSignal: controller.signal, log: { info() {} } });
  assert.equal(contexts.length, 3);
  const byMessage = new Map(contexts.map(context => [context.messageId, context]));
  assert.equal(byMessage.get("inbound-0")?.sender.id, handle);
  assert.equal(byMessage.get("inbound-1")?.sender.id, handle);
  assert.equal(byMessage.get("inbound-2")?.sender.id, otherHandle);
  assert.equal(byMessage.get("inbound-0")?.sender.name, "Person");
  assert.equal(byMessage.get("inbound-1")?.sender.name, "Person");
  assert.notEqual(byMessage.get("inbound-0")?.conversation.id, byMessage.get("inbound-1")?.conversation.id);
});
