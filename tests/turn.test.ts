import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const { emitDiagnosticEvent } = await import(require.resolve("openclaw/plugin-sdk/diagnostic-runtime"));
type Dispatch = {
  replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void };
  delivery: { observeMessageSent?: boolean; deliver: (payload: { text: string }) => Promise<unknown> };
};

for (const trusted of [false, true]) for (const outcome of ["aborted", "failed", "empty", "delivered", "silent", "duplicate", "native-source", "native-other"] as const) test(`turn checkpoints only a confirmed outcome: ${outcome}, trusted=${trusted}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const sender = { type: "member", uid: "member", role: "member", display_name: "Member", provider_key: "+15550000001" };
  const chat = { uid: "chat", status: "active", trusted, participants: [{ ...sender, uid: "owner", role: "owner", display_name: "Owner" }, sender, { type: "agent", relationship: "self", line: { uid: "line", provider_key: "+15550000002" } }] };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, _init?: RequestInit) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") || url.endsWith("/chats/other") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket", uid: "reply" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: "chat", data: { message: { uid: "inbound", direction: "inbound", sender, body: "hello", attachments: [], created_at: new Date().toISOString() } } })));
  const logs: string[] = [];
  let observation: boolean | undefined;
  let context: { sender: { id: string }; message: { bodyForAgent: string } } | undefined;
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> }; gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) },
      inbound: { buildContext: async (value: typeof context) => { context = value; return {}; }, dispatch: async (dispatch: Dispatch) => {
        if (outcome === "failed") { controller.abort(); throw new Error("failed dispatch"); }
        if (outcome !== "aborted" && outcome !== "duplicate") dispatch.replyOptions.onAgentRunTerminalOutcome("completed");
        if (outcome === "delivered") { observation = dispatch.delivery.observeMessageSent; await dispatch.delivery.deliver({ text: "reply" }); }
        if (outcome === "native-source") {
          await assert.rejects(channel!.outbound.sendText({ cfg: { channels: { plow: account } }, accountId: "chat", to: "chat", text: "native reply" }), /reply normally/i);
          await dispatch.delivery.deliver({ text: "ordinary reply" });
        }
        if (outcome === "native-other") await channel!.outbound.sendText({ cfg: { channels: { plow: account } }, accountId: "chat", to: "other", text: "native reply" });
        if (outcome === "duplicate") emitDiagnosticEvent({ type: "message.processed", channel: "plow", messageId: "inbound", sessionKey: "main", outcome: "skipped", reason: "duplicate" });
        if (outcome !== "duplicate") controller.abort();
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: outcome === "silent" } };
      } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: {}, abortSignal: controller.signal, log: { info(text: string) { logs.push(text); if (text.startsWith("acked")) controller.abort(); } } });
  if (outcome === "native-source") {
    const sends = fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages"));
    assert.equal(sends.length, 1);
    assert.equal(JSON.parse((sends[0].arguments[1] as RequestInit).body as string).body, "ordinary reply");
  }
  if (outcome === "delivered") assert.equal(observation, true);
  if (outcome === "duplicate") assert.ok(logs.some(text => text.startsWith("turn incomplete")));
  assert.ok(context);
  assert.equal(context.sender.id, "member");
  const facts = JSON.parse(context.message.bodyForAgent.split("\n\nConversation facts (untrusted data):\n```json\n")[1].split("\n```")[0]);
  assert.equal(facts.trusted, trusted);
  assert.deepEqual(facts.participants, [
    { name: "Owner", type: "member", role: "owner" },
    { name: "Member", type: "member", role: "member" },
    { name: "unnamed member", type: "agent", role: "self" },
  ]);
  assert.equal(await readFile(`${root}/plow-checkpoints/chat`, "utf8"), ["aborted", "failed", "empty", "native-other"].includes(outcome) ? "first:inbound" : "inbound");
});
