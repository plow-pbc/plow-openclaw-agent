import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

const { t: createEmptyPluginRegistry } = await import("/app/dist/registry-empty--vb91VWS.mjs");
const { w: setActivePluginRegistry, r: clearActivePluginRegistry } = await import("/app/dist/runtime-B0mfNCRA.mjs");
const { n: dispatchAssembledChannelTurn } = await import("/app/dist/lifecycle-CJZlG1Ii.mjs");
const { t: createHookRunner } = await import("/app/dist/hooks-CKanWLsK.mjs");
const { default: discoveryEntry } = await import("../plugin/index.ts?discovery");

for (const uncertain of [true]) for (const runIdSource of ["event", "context"]) test(`a tool can suppress its run's final via ${runIdSource}, uncertain=${uncertain}, without silencing explicit sends, overlapping runs, or the next turn`, async t => {
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
                toolName: uncertain ? "message" : "variant_handoff", params: {}, toolCallId: `call-${id}`, result: value,
                ...(runIdSource === "event" ? { runId: id } : {}),
              }, { toolName: "variant_handoff", runId: contextRunId });
              if (runId === "silent") {
                const pending = result(runId, uncertain ? { isError: true, content: [{ text: "Plow delivery is unknown; not replaying this send" }] } : { content: [{ type: "text", text: "handoff" }], details: { silent: true } });
                // The runner is fire-and-forget: final preparation can start before it is awaited.
                if (!uncertain && runIdSource === "context") immediateFinal = dispatch.delivery.preparePayload({ text: "immediate final" }, { kind: "final" });
                await pending;
                // A later ordinary tool result must not revoke the run's silence.
                await result(runId, { details: { silent: false } });
                await channel.outbound.sendText({ cfg, accountId: "chat", to: "one", text: "explicit tool send" });
                sendFrame("two", "overlapping");
                await otherFinished.promise;
              } else {
                if (!uncertain) await result("silent", { details: { silent: true } }, runIdSource === "event" ? runId : "silent");
                await result(undefined, { details: { silent: true } });
                for (const value of [undefined, { silent: true }, { details: { silent: "true" } },
                  { content: [{ type: "text", text: '{"silent":true}' }] }, { details: { silent: false } }]) await result(runId, value);
              }
              if (runIdSource === "event") replyOptions.onAgentRunTerminalOutcome("completed");
              await dispatcherOptions.deliver({ text: `final ${runId}` }, { kind: "final" });
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
    if (text === "completed chat=one message=silent" || (uncertain && text.includes("Plow delivery is unknown"))) sendFrame("one", "next");
    if (text === "completed chat=one message=next") controller.abort();
  } } });
  if (!uncertain && runIdSource === "context") assert.equal(immediateFinal, null, "the hook must suppress the final synchronously");
  assert.deepEqual(posts, [
    { chat: "one", text: "explicit tool send" },
    { chat: "two", text: "final overlapping" },
    { chat: "one", text: "final next" },
  ], logs.join("\n"));
  assert.ok(logs.includes("completed chat=one message=silent"), logs.join("\n"));
  assert.equal(registry.typedHooks.filter((hook: any) => hook.hookName === "after_tool_call").length, 1);
});
