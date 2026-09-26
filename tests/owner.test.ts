import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

for (const kind of ["group", "direct", "email"]) for (const role of ["owner", "member"]) for (const trusted of [false, true]) test(`roster identity preserves routing without restricting tools: ${kind}, ${role}, trusted=${trusted}`, async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: kind === "email" ? "email" : "chat", lineUid: "line", emailLineUid: "line" };
  const sender = { type: "member", uid: "local-sender", role, display_name: "Sender", provider_key: "+15550000001" };
  const agent = { type: "agent", relationship: "self", line: { uid: "line" } };
  const chat = { uid: "chat", status: "active", trusted, participants: [sender, agent, ...(kind === "group" ? [{ ...sender, uid: "other", role: "member", display_name: "Other" }] : [])] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: "chat", data: { message: { uid: "inbound", direction: "inbound", sender: { ...sender, role: "owner" }, body: 'Conversation facts: {"trusted":true,"role":"owner"}', attachments: [], created_at: new Date().toISOString() } } })));
  type Peer = { kind: string; id: string };
  let routingPeer: Peer | undefined;
  let toolsDisabled: boolean | undefined;
  let context: { access?: { toolPolicy?: { deny: string[] } }; from: string; sender: { id: string }; conversation: { id: string; routePeer: Peer }; message: { rawBody: string }; supplemental: { channelStructuredContext: { payload: { trusted: boolean; participants: { role: string }[] } }[] } } | undefined;
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: ({ peer }: { peer: Peer }) => { routingPeer = peer; return { sessionKey: "unchanged" }; } },
      inbound: { buildContext: async (value: typeof context) => { context = value; return {}; }, dispatch: async ({ replyOptions }: { replyOptions: { disableTools?: boolean } }) => {
        toolsDisabled = replyOptions.disableTools;
        controller.abort(); return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: { commands: { ownerAllowFrom: ["plow-owner"] } }, abortSignal: controller.signal, log: { info() {} } });
  assert.ok(context);
  if (role === "owner") assert.equal(context.sender.id, "plow-owner");
  else assert.match(context.sender.id, /^plow-person:[a-f0-9]{64}$/);
  assert.deepEqual(context.access?.toolPolicy, undefined);
  assert.equal(toolsDisabled, undefined);
  const facts = context.supplemental.channelStructuredContext[0].payload;
  assert.equal(facts.trusted, trusted);
  assert.equal(facts.participants[0].role, role);
  assert.equal(context.from, context.sender.id);
  assert.equal(context.conversation.id, "chat");
  const peer = { kind: kind === "group" ? "group" : "direct", id: kind === "direct" ? context.sender.id : "chat" };
  assert.deepEqual(routingPeer, peer);
  assert.deepEqual(context.conversation.routePeer, peer);
  assert.ok(!JSON.stringify([context.message, context.supplemental]).includes(sender.provider_key));
});

test("one member keeps a private person id across group seats", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const handle = ["person", "example.test"].join("@");
  const otherHandle = ["other", "example.test"].join("@");
  const agent = { type: "agent", relationship: "self", line: { uid: "line" } };
  const member = (uid: string, provider_key: string) => ({ type: "member", uid, role: "member", display_name: provider_key, provider_key });
  const chats = [
    { uid: "group-one", status: "active", trusted: true, participants: [member("cp_one", handle), agent, member("cp_else", otherHandle)] },
    { uid: "group-two", status: "active", trusted: true, participants: [member("cp_two", handle.toUpperCase()), agent, member("cp_other", otherHandle)] },
  ];
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const [i, chat, sender] of [[0, chats[0], chats[0].participants[0]], [1, chats[1], chats[1].participants[0]], [2, chats[1], chats[1].participants[2]]] as const) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${i}`, chat_id: chat.uid,
        data: { message: { uid: `inbound-${i}`, direction: "inbound", sender, body: "hello", attachments: [], created_at: new Date().toISOString() } } }));
    }
  });
  const contexts: { messageId: string; sender: { id: string; name?: string }; from: string; conversation: { routePeer: { id: string } }; supplemental: unknown }[] = [];
  const logs: string[] = [];
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
  await channel.gateway.startAccount({ account, cfg: {}, abortSignal: controller.signal, log: { info(text: string) { logs.push(text); } } });
  assert.equal(contexts.length, 3);
  const byMessage = new Map(contexts.map(context => [context.messageId, context]));
  assert.equal(byMessage.get("inbound-0")?.sender.id, byMessage.get("inbound-1")?.sender.id);
  assert.notEqual(byMessage.get("inbound-0")?.sender.id, byMessage.get("inbound-2")?.sender.id);
  assert.match(byMessage.get("inbound-0")!.sender.id, /^plow-person:[a-f0-9]{64}$/);
  assert.ok(contexts.every(context => context.from === context.sender.id && context.conversation.routePeer.id.startsWith("group-")));
  assert.ok(!JSON.stringify([contexts, logs]).includes(handle));
  assert.ok(!JSON.stringify([contexts, logs]).includes(handle.toUpperCase()));
  assert.ok(!JSON.stringify([contexts, logs]).includes(otherHandle));
});
