import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const { t: createEmptyPluginRegistry } = await import("/app/dist/registry-empty--vb91VWS.mjs");
const { w: setActivePluginRegistry, r: clearActivePluginRegistry } = await import("/app/dist/runtime-B0mfNCRA.mjs");
const { n: dispatchAssembledChannelTurn } = await import("/app/dist/lifecycle-CJZlG1Ii.mjs");
const { i: emitAgentEvent, f: onAgentEvent } = await import("/app/dist/agent-events-BOSJcayE.mjs");

test("a tool can silence its run's final without silencing explicit sends, overlapping runs, or the next turn", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(20_000);
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const chats = Object.fromEntries(["one", "two"].map(uid => [uid, { uid, status: "active", trusted: true, participants: [sender,
    { ...sender, uid: "guest", role: "member", provider_key: "+15550000002" }, { type: "agent", relationship: "self", line: { uid: "line" } }] }]));
  const cfg = { channels: { plow: account }, plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } } };
  const registry = createEmptyPluginRegistry();
  t.after(() => clearActivePluginRegistry());
  const posts: { chat: string; text: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/messages") && init?.method === "POST") {
      posts.push({ chat: path.split("/")[3], text: JSON.parse(init.body as string).body });
      return Response.json({ uid: `sent-${posts.length}` });
    }
    return Response.json(path === "/v1/chats" ? { data: Object.values(chats), has_more: false }
      : path.endsWith("/messages") ? { data: [], has_more: false } : chats[path.split("/")[3]] ?? { ticket: "ticket" });
  });
  const frame = (chat: string, uid: string) => JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat,
    data: { message: { uid, direction: "inbound", sender, body: uid, attachments: [], created_at: new Date().toISOString() } } });
  const sendFrame = (chat: string, uid: string) => { for (const socket of server.clients) socket.send(frame(chat, uid)); };
  server.on("connection", socket => socket.send(frame("one", "silent")));
  const otherFinished = Promise.withResolvers<void>();
  t.after(() => otherFinished.resolve());
  let subscriptions = 0;
  let channel: { outbound: { sendText: (ctx: object) => Promise<unknown> }; gateway: { startAccount: (ctx: object) => Promise<void> } };
  const logs: string[] = [];
  entry.register({ registrationMode: "full", logger: { info() {} }, on() {}, registerTool() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; registry.channels.push({ pluginId: "plow", plugin: channel, source: "fixture" }); setActivePluginRegistry(registry); },
    runtime: {
      events: { onAgentEvent(listener: (event: unknown) => void) {
        subscriptions++;
        const unsubscribe = onAgentEvent(listener);
        return () => { subscriptions--; unsubscribe(); };
      } },
      channel: {
        routing: { resolveAgentRoute: ({ peer }: { peer: { id: string } }) => ({ agentId: "main", sessionKey: `agent:main:plow:group:${peer.id}` }) },
        inbound: {
          buildContext: async (input: any) => ({ SessionKey: input.route.sessionKey, AgentId: "main", From: sender.provider_key,
            To: input.conversation.id, OriginatingChannel: "plow", OriginatingTo: input.conversation.id,
            AccountId: "chat", ChatType: "group", SenderId: sender.provider_key, MessageSid: input.messageId }),
          dispatch: async (dispatch: any) => dispatchAssembledChannelTurn({
            cfg, channel: "plow", accountId: "chat", agentId: "main", routeSessionKey: dispatch.route.sessionKey,
            storePath: `${root}/agents/main/sessions/sessions.json`, ctxPayload: dispatch.ctxPayload,
            recordInboundSession: async () => {}, delivery: dispatch.delivery, replyOptions: dispatch.replyOptions,
            dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions, replyOptions }: any) => {
              const runId = dispatch.ctxPayload.MessageSid;
              replyOptions.onAgentRunStart(runId);
              const result = (id: string, value: unknown, phase = "result", stream = "tool") => emitAgentEvent({
                runId: id, stream, data: { phase, name: "variant_handoff", toolCallId: `call-${id}`, result: value },
              });
              if (runId === "silent") {
                result(runId, { content: [{ type: "text", text: "handoff" }], details: { silent: true } });
                // A later ordinary tool result must not revoke the run's silence.
                result(runId, { details: { silent: false } });
                await channel.outbound.sendText({ cfg, accountId: "chat", to: "one", text: "explicit tool send" });
                sendFrame("two", "overlapping");
                await otherFinished.promise;
              } else {
                result("silent", { details: { silent: true } });
                for (const value of [undefined, { silent: true }, { details: { silent: "true" } },
                  { content: [{ type: "text", text: '{"silent":true}' }] }, { details: { silent: false } }]) result(runId, value);
                result(runId, { details: { silent: true } }, "update");
                result(runId, { details: { silent: true } }, "result", "assistant");
              }
              replyOptions.onAgentRunTerminalOutcome("completed");
              await dispatcherOptions.deliver({ text: `final ${runId}` }, { kind: "final" });
              if (runId === "overlapping") otherFinished.resolve();
              return { counts: { final: 1 }, queuedFinal: true };
            },
          }),
        },
      },
    },
  });
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(text: string) {
    logs.push(text);
    if (text === "completed chat=one message=silent") sendFrame("one", "next");
    if (text === "completed chat=one message=next") controller.abort();
  } } });
  assert.deepEqual(posts, [
    { chat: "one", text: "explicit tool send" },
    { chat: "two", text: "final overlapping" },
    { chat: "one", text: "final next" },
  ], logs.join("\n"));
  assert.ok(logs.includes("completed chat=one message=silent"), logs.join("\n"));
  assert.equal(subscriptions, 0);
});
