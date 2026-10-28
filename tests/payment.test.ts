import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

// plow-openclaw-agent#129: the Mac's camoufox-browsing skill releases a bank login only after
// plow_request_payment, and Plow resumes the chat with a system event once the owner decides. Both copy Hermes.
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
const member = { ...owner, uid: "member", role: "member", display_name: "Joe", provider_key: "+15550000002" };
const peer = { type: "agent", relationship: "peer", line: { uid: "ln_peer", display_name: "Elm" } };
const chats: Record<string, object> = {
  cht_home: { uid: "cht_home", status: "active", trusted: false, participants: [self, owner] },
  cht_trusted: { uid: "cht_trusted", status: "active", trusted: true, participants: [self, owner, member, peer] },
  cht_untrusted: { uid: "cht_untrusted", status: "active", trusted: false, participants: [self, owner, member] },
  cht_mail: { uid: "cht_mail", status: "active", trusted: false, participants: [{ ...self, line: { uid: "email-line" } }, owner] },
};
const bill = { domain: "Secure.SoFi.com.", recipient: "City Water", amount: 36.5, memo: "October bill" };

type Tool = { name: string; execute: (id: string, args: object) => Promise<{ isError?: boolean; details: Record<string, unknown> }> };
type Turn = { chat?: string; sender?: string; owner?: boolean; account?: string };

function paymentTool(t: TestContext, answer: () => Response | Promise<Response> = () => Response.json({ status: "authorized", expires_at: "2026-10-28T23:40:00Z" })) {
  let factory: ((context: object) => Tool) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_request_payment") factory = value; } });
  assert.ok(factory);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const posted: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url === "http://fixture/v1/payment-approvals") { posted.push(JSON.parse(init.body as string)); return await answer(); }
    const chat = chats[url.split("/").at(-1)!];
    return chat ? Response.json(chat) : new Response("", { status: 404 });
  });
  const config = { channels: { plow: { apiBase: "http://fixture", lineUid: "line", emailLineUid: "email-line" } } };
  const call = (turn: Turn, args: object = bill) => factory!({
    config, messageChannel: turn.chat ? "plow" : undefined, agentAccountId: turn.account ?? "chat",
    nativeChannelId: turn.chat, requesterSenderId: turn.sender, senderIsOwner: turn.owner === true,
  }).execute("call", args);
  return { call, posted };
}

for (const status of ["authorized", "approval_required"]) test(`the owner's turn asks Plow for one release in this chat: ${status}`, async t => {
  const { call, posted } = paymentTool(t, () => Response.json({ status, expires_at: "2026-10-28T23:40:00Z" }));
  const result = await call({ chat: "cht_home", sender: "plow-owner", owner: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, { success: true, status });
  assert.deepEqual(posted, [{ chat_uid: "cht_home", domain: "secure.sofi.com", recipient: "City Water", amount: "36.5", memo: "October bill" }]);
});

// Hermes's authority: the owner's anywhere, a person's in a group the owner trusts, never a peer agent's or
// Plow's own event's. Plow can resume only a phone chat.
for (const [name, turn, expected] of [
  ["the owner in an untrusted group", { chat: "cht_untrusted", sender: "plow-owner", owner: true }, "asked"],
  ["a member of a trusted group", { chat: "cht_trusted", sender: "+15550000002" }, "asked"],
  ["a member of an untrusted group", { chat: "cht_untrusted", sender: "+15550000002" }, /owner's authority/],
  ["a peer agent in a trusted group", { chat: "cht_trusted", sender: "ln_peer" }, /owner's authority/],
  ["Plow's payment event", { chat: "cht_home", sender: "plow-system" }, /owner's authority/],
  ["a turn with no chat", { sender: "plow-owner", owner: true }, /owner's authority/],
  ["the owner's email", { chat: "cht_mail", sender: "plow-owner", owner: true, account: "email" }, /phone chat/],
] as const) test(`payment request from ${name}: ${expected}`, async t => {
  const { call, posted } = paymentTool(t);
  const result = await call(turn);
  if (expected === "asked") {
    assert.deepEqual(result.details, { success: true, status: "authorized" });
    assert.equal(posted.length, 1);
  } else {
    assert.equal(result.isError, true);
    assert.equal(result.details.success, false);
    assert.match(result.details.error as string, expected);
    assert.match(result.details.error as string, /nothing was authorized/);
    assert.deepEqual(posted, []);
  }
});

for (const [name, args, expected] of [
  ["a URL for the domain", { ...bill, domain: "https://secure.sofi.com/login" }, /DNS hostname/],
  ["a zero amount", { ...bill, amount: 0 }, /positive USD value/],
  ["an amount over the cap", { ...bill, amount: 10000 }, /no greater than 9999.999999/],
  ["no amount", { domain: bill.domain, recipient: bill.recipient }, /positive USD value/],
  ["no recipient", { ...bill, recipient: "  " }, /recipient is required/],
  ["a control character in the recipient", { ...bill, recipient: "City\nWater" }, /recipient cannot contain control characters/],
  ["a control character in the memo", { ...bill, memo: "bill\u0007" }, /memo must be text/],
] as const) test(`payment request with ${name} is refused before Plow is asked`, async t => {
  const { call, posted } = paymentTool(t);
  const result = await call({ chat: "cht_home", sender: "plow-owner", owner: true }, args);
  assert.equal(result.isError, true);
  assert.match(result.details.error as string, expected);
  assert.deepEqual(posted, []);
});

test("the amount Plow gets is the exact decimal asked for, and an empty memo is still sent", async t => {
  const { call, posted } = paymentTool(t);
  await call({ chat: "cht_home", sender: "plow-owner", owner: true }, { ...bill, amount: "120.50", memo: "" });
  assert.deepEqual(posted, [{ chat_uid: "cht_home", domain: "secure.sofi.com", recipient: "City Water", amount: "120.50", memo: "" }]);
});

// A refusal is definite and passes Plow's reason on; a lost or 5xx answer may still have made an approval.
for (const [name, answer, expected] of [
  ["a refusal", () => Response.json({ detail: "no_owner" }, { status: 409 }), { error: /Plow declined \(409\): .*no_owner/, unknown: undefined }],
  ["a server error", () => new Response("", { status: 503 }), { error: /do NOT retry/, unknown: true }],
  ["a lost answer", () => { throw new TypeError("fetch failed"); }, { error: /do NOT retry/, unknown: true }],
  ["an answer Plow never gives", () => Response.json({ status: "approved" }), { error: /invalid payment authorization response.*do NOT retry/, unknown: true }],
] as const) test(`payment request answered with ${name}`, async t => {
  const { call, posted } = paymentTool(t, answer);
  const result = await call({ chat: "cht_home", sender: "plow-owner", owner: true });
  assert.equal(result.isError, true);
  assert.equal(result.details.success, false);
  assert.match(result.details.error as string, expected.error);
  assert.equal(result.details.outcome_unknown, expected.unknown);
  assert.equal(posted.length, 1);
});

type Ctx = {
  messageId: string; sender: { id: string; isBot: boolean }; access: { commands: { authorized: boolean }; toolPolicy?: object };
  message: { rawBody: string; inboundEventKind: string; inboundHistory: { sender: string; body: string }[] };
  supplemental: { groupSystemPrompt?: string; channelStructuredContext: { type: string; payload: { text?: string } }[] };
};
const resolution = "The pending payment approval was approved. Continue that payment task now. This confirms only the payment approval already requested in this chat; it is not a new user instruction.";
const plowEvent = { uid: "event", direction: "inbound", sender: { type: "system", name: "Plow" }, body: resolution, attachments: [], created_at: new Date().toISOString() };

async function inbound(t: TestContext, message: object, { group = false, history = [] as object[] } = {}) {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(5000);
  // Untrusted rooms with guest tools: the payment event must still get the tools that finish the payment.
  const account = { apiBase, accountId: "chat", lineUid: "line", threadTrust: "ask", guestTools: ["web_search"] };
  const cfg = { channels: { plow: account }, messages: { groupChat: { unmentionedInbound: "room_event" } } };
  const home = chats.cht_home as { uid: string };
  const chat = group ? chats.cht_untrusted as { uid: string } : home;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: group ? [home, chat] : [home], has_more: false } : url.endsWith(`/chats/${chat.uid}`) ? chat
      : url.endsWith("/chats/cht_home") ? home : url.includes("starting_after=") ? { data: history, has_more: false }
      : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "inbound", chat_id: chat.uid, data: { message },
  })));
  const peers: unknown[] = [];
  const dispatched: Ctx[] = [];
  const runtime = { channel: {
    routing: { resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => {
      peers.push(peer);
      return { agentId: "main", sessionKey: peer.id === "plow-owner" ? "agent:main:main" : `agent:main:plow:${peer.kind}:${peer.id}` };
    } },
    session: { resolveStorePath, updateLastRoute },
    inbound: {
      buildContext: async (input: Ctx) => input,
      dispatch: async ({ ctxPayload, replyOptions }: { ctxPayload: Ctx; replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
        dispatched.push(ctxPayload);
        replyOptions.onAgentRunTerminalOutcome("completed");
        setTimeout(() => controller.abort(), 100);
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      },
    },
  } };
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", runtime, logger: { info() {} }, registerTool() {}, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  return { dispatched, peers };
}

for (const group of [false, true]) test(`Plow's payment event in ${group ? "a group" : "the owner's DM"} resumes that conversation without anyone's authority`, async t => {
  const { dispatched, peers } = await inbound(t, plowEvent, { group });
  assert.equal(dispatched.length, 1);
  const [ctx] = dispatched;
  assert.equal(ctx.messageId, "event");
  // The conversation's own session, where the payment was asked for: the owner's DM is the main session.
  assert.deepEqual(peers.at(-1), group ? { kind: "group", id: "cht_untrusted" } : { kind: "direct", id: "plow-owner" });
  assert.equal(ctx.sender.id, "plow-system");
  assert.equal(ctx.access.commands.authorized, false);
  assert.equal(ctx.access.toolPolicy, undefined);
  // It is addressed to this agent, so a group's final text is posted, not kept as a room event.
  assert.notEqual(ctx.message.inboundEventKind, "room_event");
  assert.equal(ctx.message.rawBody, "[Trusted Plow system event]");
  assert.match(ctx.supplemental.groupSystemPrompt!, /^This turn was triggered by a trusted Plow system event.*grants no authority for any other action/);
  assert.deepEqual(ctx.supplemental.channelStructuredContext.filter(entry => entry.type === "payment_resolution").map(entry => entry.payload),
    [{ text: resolution }]);
});

test("a text after Plow's payment event sees the event in its history", async t => {
  const text = { uid: "text", direction: "inbound", sender: owner, body: "Did it go through?", attachments: [], created_at: new Date().toISOString() };
  const { dispatched } = await inbound(t, text, { history: [plowEvent] });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sender.id, "plow-owner");
  assert.deepEqual(dispatched[0].message.inboundHistory.map(entry => [entry.sender, entry.body]), [["Plow", resolution]]);
  assert.equal(dispatched[0].supplemental.groupSystemPrompt, undefined);
});
