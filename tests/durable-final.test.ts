import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

// Exercise custody and restart recovery in the pinned runtime, including its SQLite queue.
const { t: createEmptyPluginRegistry } = await import("/app/dist/registry-empty--vb91VWS.mjs");
const { w: setActivePluginRegistry, r: clearActivePluginRegistry } = await import("/app/dist/runtime-B0mfNCRA.mjs");
const { n: dispatchAssembledChannelTurn } = await import("/app/dist/lifecycle-CJZlG1Ii.mjs");
const { T: setReplyPayloadMetadata } = await import("/app/dist/reply-payload-B2ZQhznY.mjs");
const { h: replaceSessionEntry, s: loadSessionEntry } = await import("/app/dist/session-accessor.sqlite-entry-UCl9kr-O.mjs");
const { recoverRestartAbortedMainSessions } = await import("/app/dist/main-session-restart-recovery-CZEAhJMd.mjs");

test("an overlapping turn after the outbound row does not owe a delivery notice", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(20_000);
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const chat = { uid: "home", status: "active", trusted: true, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const sessionKey = "agent:main:main", sessionId = "overlapping-final";
  const storePath = `${root}/agents/main/sessions/sessions.json`;
  await mkdir(`${root}/agents/main/sessions`, { recursive: true });
  const scope = { storePath, sessionKey };
  const cfg = { channels: { plow: account }, plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } } };
  const sendResponse = Promise.withResolvers<void>();
  t.after(() => sendResponse.resolve());
  const frame = (uid: string) => JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: "home", data: { message: { uid, direction: "inbound", sender, body: uid, attachments: [], created_at: new Date().toISOString() } } });
  const registry = createEmptyPluginRegistry();
  t.after(() => clearActivePluginRegistry());
  const rows: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/chats/home/messages") && init?.method === "POST") {
      rows.push(JSON.parse(init.body as string).body);
      for (const socket of server.clients) socket.send(frame("second"));
      // The row exists, but the first dispatcher has not received confirmation yet.
      await sendResponse.promise;
      return Response.json({ uid: "outbound-first" });
    }
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", socket => socket.send(frame("first")));
  let channel: { gateway: { startAccount: (ctx: object) => Promise<void> } };
  let secondEntry: Record<string, unknown> | undefined;
  let recovery: unknown;
  let beforeRecovery: unknown;
  let dispatches = 0;
  const logs: string[] = [];
  entry.register({ registrationMode: "full", logger: { info() {} }, on() {}, registerTool() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; registry.channels.push({ pluginId: "plow", plugin: channel, source: "fixture" }); setActivePluginRegistry(registry); },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey }) },
      inbound: { buildContext: async () => ({ SessionKey: sessionKey, AgentId: "main", From: sender.provider_key, To: "home", OriginatingChannel: "plow", OriginatingTo: "home", AccountId: "chat", ChatType: "direct", SenderId: sender.provider_key }),
        dispatch: async (dispatch: { delivery: object }) => {
          if (++dispatches === 2) {
            try {
              beforeRecovery = loadSessionEntry(scope);
              recovery = await recoverRestartAbortedMainSessions({ cfg, stateDir: root });
              secondEntry = loadSessionEntry(scope);
            } finally { sendResponse.resolve(); }
            return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true, counts: { final: 0 } } };
          }
          await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now(), status: "running", abortedLastRun: true, permissionMode: "guarded",
            pendingFinalDelivery: { kind: "replayable", text: "Reply one", createdAt: Date.now(), intentId: "final-one", context: { channel: "plow", to: "home", accountId: "chat" }, deliveries: [{ id: "payload-one", state: "prepared" }] } });
          const payload = setReplyPayloadMetadata({ text: "Reply one", replyToId: "first", replyToCurrent: true }, { pendingFinalDeliveryCompletion: { storePath, sessionKey, sessionId, intentId: "final-one", deliveryId: "payload-one" } });
          return dispatchAssembledChannelTurn({ cfg, channel: "plow", accountId: "chat", agentId: "main", routeSessionKey: sessionKey, storePath,
            ctxPayload: { SessionKey: sessionKey, AgentId: "main", From: sender.provider_key, To: "home", AccountId: "chat", ChatType: "direct", SenderId: sender.provider_key },
            recordInboundSession: async () => {}, delivery: dispatch.delivery,
            dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }: { dispatcherOptions: { deliver: (payload: object, info: object) => Promise<unknown> } }) => {
              await dispatcherOptions.deliver(payload, { kind: "final" });
              return { counts: { final: 1 }, queuedFinal: true };
            } });
        } },
    } },
  });
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(text: string) { logs.push(text); if (text.startsWith("completed chat=home message=first")) controller.abort(); } } });
  assert.equal(dispatches, 2, logs.join("\n"));
  assert.deepEqual(rows, ["Reply one"]);
  assert.ok(secondEntry, "the second turn exercised core recovery while the provider response was pending");
  assert.equal(secondEntry.pendingDeliveryNotice, undefined, JSON.stringify({beforeRecovery,logs}));
  assert.deepEqual(recovery, { started: 0, settled: 0, failed: 0, skipped: 1 });
});
