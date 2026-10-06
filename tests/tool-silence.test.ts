import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const { t: createEmptyPluginRegistry } = await import("/app/dist/registry-empty--vb91VWS.mjs");
const { w: setActivePluginRegistry, r: clearActivePluginRegistry } = await import("/app/dist/runtime-B0mfNCRA.mjs");
const { n: dispatchAssembledChannelTurn } = await import("/app/dist/lifecycle-CJZlG1Ii.mjs");
const { t: createHookRunner } = await import("/app/dist/hooks-CKanWLsK.mjs");
const { default: discoveryEntry } = await import("../plugin/index.ts?discovery");

for (const runIdSource of ["event", "context"]) for (const outcome of ["silent", "cleared", "silenced-again", "assistant-silent", "silent-error"]) test(`tool silence via ${runIdSource}: ${outcome}, with explicit sends, overlapping runs, and the next turn`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(20_000);
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const chats = Object.fromEntries(["one", "two"].map(uid => [uid, { uid, status: "active", trusted: true, participants: [sender,
    { ...sender, uid: "guest", role: "member", provider_key: "+15550000002" }, { type: "agent", relationship: "self", line: { uid: "line" } }] }]));
  const cfg = { channels: { plow: account }, plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } } };
  const registry = createEmptyPluginRegistry();
  const hooks = createHookRunner(registry, { catchErrors: false });
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
  let immediateFinal: unknown;
  let toggledFinal: unknown;
  let channel: { outbound: { sendText: (ctx: object) => Promise<unknown> }; gateway: { startAccount: (ctx: object) => Promise<void> } };
  const logs: string[] = [];
  const api = { registrationMode: "full", logger: { info() {} }, registerTool() {},
    on(hookName: string, handler: (...args: any[]) => unknown) { registry.typedHooks.push({ pluginId: "plow", hookName, handler, source: "fixture" }); },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; registry.channels.push({ pluginId: "plow", plugin: channel, source: "fixture" }); setActivePluginRegistry(registry); },
    runtime: {
      events: { onAgentEvent: () => () => {} },
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
              const result = (id: string | undefined, value: unknown, contextRunId = id) => hooks.runAfterToolCall({
                toolName: "variant_handoff", params: {}, toolCallId: `call-${id}`, result: value,
                ...(runIdSource === "event" ? { runId: id } : {}),
              }, { toolName: "variant_handoff", runId: contextRunId });
              if (runId === "silent") {
                const pending = outcome === "assistant-silent" ? hooks.runAgentEnd({
                  ...(runIdSource === "event" ? { runId } : {}), success: true,
                  messages: [{ role: "assistant", content: "Earlier answer" }, { role: "user", content: "Thanks" },
                    { role: "assistant", content: runIdSource === "event" ? "NO_REPLY" : [{ type: "thinking", thinking: "done" }, { type: "text", text: "NO_REPLY" }] }],
                }, { runId }) : result(runId, { content: [{ type: "text", text: "handoff" }], details: { silent: true } });
                // The runner is fire-and-forget: final preparation can start before it is awaited.
                immediateFinal = dispatch.delivery.preparePayload({ text: "immediate final" }, { kind: "final" });
                await pending;
                if (outcome === "cleared" || outcome === "silenced-again") {
                  const clearing = result(runId, { details: { silent: false } });
                  toggledFinal = dispatch.delivery.preparePayload({ text: "cleared final" }, { kind: "final" });
                  await clearing;
                  if (outcome === "silenced-again") await result(runId, { details: { silent: true } });
                }
                // Results without an explicit boolean leave the current state alone.
                for (const value of [undefined, {}, { details: {} }, { silent: false }, { details: { silent: "false" } },
                  { details: { silent: 0 } }, { content: [{ type: "text", text: '{"silent":false}' }] }]) await result(runId, value);
                await channel.outbound.sendText({ cfg, accountId: "chat", to: "one", text: "explicit tool send" });
                if (outcome === "silent-error") replyOptions.onObservedReplyDelivery();
                sendFrame("two", "overlapping");
                await otherFinished.promise;
              } else {
                const staleRunId = runId === "next" ? "silent" : "unknown";
                await result(staleRunId, { details: { silent: true } }, runIdSource === "event" ? runId : staleRunId);
                await result(undefined, { details: { silent: true } });
                await hooks.runAgentEnd({ runId: staleRunId, success: true, messages: [{ role: "assistant", content: "NO_REPLY" }] }, { runId });
                await hooks.runAgentEnd({ success: true, messages: [{ role: "assistant", content: "Normal final" }, { role: "tool", content: "NO_REPLY" }] }, { runId });
                for (const value of [undefined, { silent: true }, { details: { silent: "true" } },
                  { content: [{ type: "text", text: '{"silent":true}' }] }, { details: { silent: false } }]) await result(runId, value);
              }
              if (runIdSource === "event") replyOptions.onAgentRunTerminalOutcome("completed");
              await dispatcherOptions.deliver(runId === "silent" && outcome === "silent-error"
                ? { text: "Provider failed: internal run trace", isError: true }
                : { text: outcome === "assistant-silent" && runId === "silent"
                  ? "The tool run finished, but no final summary was produced. I did not repeat any completed actions." : `final ${runId}` }, { kind: "final" });
              if (runIdSource === "context") replyOptions.onAgentRunTerminalOutcome("completed");
              if (runId === "overlapping") otherFinished.resolve();
              return { counts: { final: 1 }, queuedFinal: true };
            },
          }),
        },
      },
    },
  };
  entry.register(api);
  if (runIdSource === "context") {
    // The live gateway can dispatch hooks through a separately loaded discovery registry.
    registry.typedHooks.length = 0;
    discoveryEntry.register({ ...api, registrationMode: "discovery", registerChannel() {} });
  }
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(text: string) {
    logs.push(text);
    if (text === "completed chat=one message=silent") sendFrame("one", "next");
    if (text === "completed chat=one message=next") controller.abort();
  } } });
  assert.equal(immediateFinal, null, "the hook must suppress the final synchronously");
  if (outcome === "cleared" || outcome === "silenced-again") assert.deepEqual(toggledFinal, { text: "cleared final", replyToId: undefined, replyToCurrent: false }, "the hook must clear suppression synchronously, even after a final was prepared");
  assert.deepEqual(posts, [
    { chat: "one", text: "explicit tool send" },
    { chat: "two", text: "final overlapping" },
    ...(outcome === "cleared" ? [{ chat: "one", text: "final silent" }] : []),
    ...(outcome === "silent-error" ? [{ chat: "one", text: "Sorry, I couldn't finish that just now. Some actions may have completed; check before retrying." }] : []),
    { chat: "one", text: "final next" },
  ], logs.join("\n"));
  assert.ok(logs.includes("completed chat=one message=silent"), logs.join("\n"));
  assert.equal(registry.typedHooks.filter((hook: any) => hook.hookName === "after_tool_call").length, 1);
});
