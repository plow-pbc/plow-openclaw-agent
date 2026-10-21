import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { nativeSendPolicy } from "./native-message-policy.ts";
import entry from "../plugin/index.ts";
import { checkpointUid, websocketFixture } from "./ws-fixture.ts";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const { emitDiagnosticEvent } = await import(require.resolve("openclaw/plugin-sdk/diagnostic-runtime"));
type Dispatch = {
  cfg: { messages?: { visibleReplies?: string } };
  replyOptions: { disableTools?: boolean; sourceReplyDeliveryMode?: "automatic" | "message_tool_only"; onAgentRunTerminalOutcome: (outcome: string) => void; onObservedReplyDelivery?: () => void };
  delivery: { observeMessageSent?: boolean; preparePayload?: (payload: { text: string; isError?: boolean; isFallbackNotice?: boolean }, info: { kind: "final" }) => { text: string } | null; deliver: (payload: { text: string }) => Promise<unknown> };
};

for (const trusted of [false, true]) for (const outcome of trusted ? ["delivered"] as const : ["aborted", "failed", "empty", "delivered", "plain-final", "slash-final", "silent", "duplicate", "native-source", "native-source-final", "native-source-plus-final", "native-other", "error-notice", "fallback-notice", "terminal-notice", "reminder-note", "observed", "queued", "deferred"] as const) test(`turn checkpoints only a confirmed outcome: ${outcome}, trusted=${trusted}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const sender = { type: "member", uid: "member", role: "member", display_name: "Member", provider_key: "+15550000001" };
  const silent = [
    { ...sender, uid: "phone", display_name: "Phone", provider_key: "+1 (555) 000-0002" },
    { ...sender, uid: "email", display_name: "Email", provider_key: "Guest@Example.test" },
    { ...sender, uid: "null", display_name: "Null", provider_key: null },
    { ...sender, uid: "missing", display_name: "Missing", provider_key: undefined },
  ];
  const chat = { uid: "chat", status: "active", trusted, participants: [{ ...sender, uid: "owner", role: "owner", display_name: "Owner" }, sender, ...silent, { type: "agent", relationship: "self", line: { uid: "line", provider_key: "+15550000002" } }] };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, _init?: RequestInit) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") || url.endsWith("/chats/other") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket", uid: "reply" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: "chat", data: { message: { uid: "inbound", direction: "inbound", sender, body: outcome === "slash-final" ? "/status" : "hello", attachments: [], created_at: new Date().toISOString() } } })));
  const logs: string[] = [];
  let observation: boolean | undefined;
  let nativeOtherFailure: unknown;
  let strandedRetry: (() => Promise<unknown>) | undefined;
  let context: { sender: { id: string }; message: { bodyForAgent?: string; rawBody: string }; supplemental: { channelStructuredContext: { label: string; payload: { trusted: boolean; participants: unknown[] } }[] } } | undefined;
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> }; gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) },
      inbound: { buildContext: async (value: typeof context) => { context = value; return {}; }, dispatch: async (dispatch: Dispatch) => {
        if (outcome === "failed") { controller.abort(); throw new Error("failed dispatch"); }
        if (outcome !== "aborted" && outcome !== "duplicate") dispatch.replyOptions.onAgentRunTerminalOutcome("completed");
        if (outcome === "terminal-notice") {
          dispatch.replyOptions.onAgentRunTerminalOutcome("failed");
          const raw = { text: "runtime terminal fallback" };
          if (!dispatch.delivery.preparePayload || dispatch.delivery.preparePayload(raw, { kind: "final" }) !== null) await dispatch.delivery.deliver(raw);
        }
        if (outcome === "error-notice" || outcome === "fallback-notice") {
          const raw = { text: "runtime diagnostic", ...(outcome === "error-notice" ? { isError: true } : { isFallbackNotice: true }) };
          const prepared = dispatch.delivery.preparePayload ? dispatch.delivery.preparePayload(raw, { kind: "final" }) : raw;
          if (prepared !== null) await dispatch.delivery.deliver(prepared);
          if (outcome === "error-notice") dispatch.replyOptions.onAgentRunTerminalOutcome("failed");
          else await dispatch.delivery.deliver({ text: "fallback answer" });
        }
        if (outcome === "delivered") { observation = dispatch.delivery.observeMessageSent; await dispatch.delivery.deliver({ text: "reply" }); }
        if (outcome === "plain-final" || outcome === "slash-final") {
          if (outcome === "slash-final") assert.equal(dispatch.replyOptions.disableTools, true);
          if (dispatch.replyOptions.sourceReplyDeliveryMode === "automatic") await dispatch.delivery.deliver({ text: "plain reply" });
          else strandedRetry = () => channel!.outbound.sendText({ cfg: { channels: { plow: account } }, accountId: "chat", to: "chat", text: "plain reply" });
        }
        if (outcome === "native-source" || outcome === "native-source-final") {
          await channel!.outbound.sendText({ cfg: { channels: { plow: account } }, accountId: "chat", to: "plow:chat", text: "native reply" });
        }
        if (outcome === "native-source-plus-final") {
          await channel!.outbound.sendText({ cfg: { channels: { plow: account } }, accountId: "chat", to: "plow:chat", text: "native reply" });
          dispatch.replyOptions.onObservedReplyDelivery?.();
          const final = { text: "redundant final" };
          if (!dispatch.delivery.preparePayload || dispatch.delivery.preparePayload(final, { kind: "final" }) !== null) await dispatch.delivery.deliver(final);
        }
        if (outcome === "reminder-note") {
          const reply = { text: "I'll follow up here.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically." };
          const prepared = dispatch.delivery.preparePayload ? dispatch.delivery.preparePayload(reply, { kind: "final" }) : reply;
          if (prepared !== null) await dispatch.delivery.deliver(prepared);
        }
        if (outcome === "native-other") {
          try { nativeSendPolicy("chat", "other"); await channel!.outbound.sendText({ cfg: { channels: { plow: account } }, accountId: "chat", to: "other", text: "native reply" }); }
          catch (error) { nativeOtherFailure = error; }
        }
        if (outcome === "observed") dispatch.replyOptions.onObservedReplyDelivery?.();
        if (outcome === "duplicate") emitDiagnosticEvent({ type: "message.processed", channel: "plow", messageId: "inbound", sessionKey: "main", outcome: "skipped", reason: "duplicate" });
        if (outcome !== "duplicate" && outcome !== "error-notice" && outcome !== "terminal-notice" && outcome !== "plain-final" && outcome !== "slash-final") controller.abort();
        // The host withholds final text after a message-tool send.
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: outcome === "silent", observedReplyDelivery: outcome === "native-source" || outcome === "native-source-final", queuedFinal: outcome === "queued", counts: { final: ["delivered", "plain-final", "slash-final", "fallback-notice", "error-notice", "terminal-notice", "reminder-note"].includes(outcome) ? 1 : 0 }, deferredToActiveRun: outcome === "deferred" ? "followup" : undefined, finalText: outcome === "native-source-final" ? "final reply" : undefined } };
      } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: { messages: { visibleReplies: "automatic" } }, abortSignal: controller.signal, log: { info(text: string) { logs.push(text); if (text.startsWith("acked")) controller.abort(); } } });
  if (outcome === "plain-final" || outcome === "slash-final") {
    assert.equal(strandedRetry, undefined);
    await strandedRetry?.();
    const texts = fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages")).map(call => JSON.parse((call.arguments[1] as RequestInit).body as string).body);
    assert.deepEqual(texts, ["plain reply"]);
    assert.ok(logs.some(text => text.startsWith("completed chat=chat message=inbound")));
  }
  if (outcome === "native-source" || outcome === "native-source-final" || outcome === "native-source-plus-final") {
    const sends = fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages"));
    assert.equal(sends.length, 1);
    assert.equal(JSON.parse((sends[0].arguments[1] as RequestInit).body as string).body, "native reply");
    assert.ok(logs.some(text => text.startsWith("completed chat=chat message=inbound")));
    assert.ok(!logs.some(text => text.startsWith("turn incomplete")));
  }
  if (["observed", "queued"].includes(outcome)) {
    assert.ok(logs.some(text => text.startsWith("completed chat=chat message=inbound")));
    assert.ok(!logs.some(text => text.startsWith("turn incomplete")));
  }
  if (outcome === "deferred") assert.ok(logs.some(text => text.startsWith("deferred chat=chat message=inbound")));
  if (outcome === "native-other") {
    assert.match((nativeOtherFailure as Error)?.message, /Cross-context messaging denied/);
    assert.equal(fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages")).length, 0);
  }
  if (outcome === "error-notice" || outcome === "fallback-notice" || outcome === "terminal-notice") {
    const texts = fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages")).map(call => JSON.parse((call.arguments[1] as RequestInit).body as string).body);
    assert.deepEqual(texts, outcome === "fallback-notice" ? ["fallback answer"] : [outcome === "error-notice" ? "Sorry, I couldn't finish that just now. Some actions may have completed; check before retrying." : "runtime terminal fallback"]);
  }
  if (outcome === "reminder-note") {
    const texts = fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages")).map(call => JSON.parse((call.arguments[1] as RequestInit).body as string).body);
    assert.deepEqual(texts, ["I'll follow up here.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically."]);
  }
  if (outcome === "delivered") assert.equal(observation, true);
  if (outcome === "duplicate") assert.ok(logs.some(text => text.startsWith("turn incomplete")));
  assert.ok(context);
  assert.equal(context.sender.id, sender.provider_key);
  // Facts travel beside the message, so the text people see in the dashboard is only what was texted.
  assert.equal(context.message.bodyForAgent, undefined);
  assert.equal(context.message.rawBody, outcome === "slash-final" ? "/status" : "hello");
  const [factsEntry] = context.supplemental.channelStructuredContext;
  assert.equal(factsEntry.label, "Conversation facts (untrusted data)");
  // The model reads the payload as rendered JSON.
  const facts = JSON.parse(JSON.stringify(factsEntry.payload));
  assert.equal(facts.trusted, trusted);
  assert.deepEqual(facts.participants, [
    { name: "Owner", type: "member", role: "owner", handle: sender.provider_key },
    { name: "Member", type: "member", role: "member", handle: sender.provider_key },
    { name: "Phone", type: "member", role: "member", handle: "+15550000002" },
    { name: "Email", type: "member", role: "member", handle: "guest@example.test" },
    { name: "Null", type: "member", role: "member" },
    { name: "Missing", type: "member", role: "member" },
    { type: "agent", role: "self" },
  ]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), ["aborted", "failed", "empty", "native-other", "deferred", "duplicate", "error-notice", "terminal-notice"].includes(outcome) ? "first:inbound" : "inbound");
});
