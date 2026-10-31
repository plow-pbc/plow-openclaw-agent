import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

type Dispatch = {
  replyOptions: { onAgentRunTerminalOutcome: (outcome: string) => void };
  delivery: { deliver: (payload: { text: string }) => Promise<unknown> };
};

// An owner texting from a phone and from a linked Apple ID email has one 1:1 chat per handle.
test("the owner's threads share one session; a reply stays in the thread written, other sends go where they last wrote", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const participants = [owner, { type: "agent", relationship: "self", line: { uid: "line" } }];
  const chats = Object.fromEntries(["phone", "mac"].map(uid => [uid, { uid, status: "active", trusted: true, participants }]));
  // Where the owner last wrote, read only once the turn has started: the mac thread, after the phone.
  let wrote: Record<string, string> | undefined;
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ uid: "sent" });
    if (url.endsWith("/chats")) return Response.json({ data: Object.values(chats), has_more: false });
    const chat = url.match(/\/chats\/([^/?]+)$/)?.[1];
    if (chat) return Response.json(chats[chat]);
    const thread = url.match(/\/chats\/([^/]+)\/messages\?limit=50$/)?.[1];
    if (thread && wrote) return Response.json({ data: [{ uid: `${thread}-owner`, direction: "inbound", sender: owner, created_at: wrote[thread] }], has_more: false });
    return Response.json(url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const chat of ["phone", "mac"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${chat}`, chat_id: chat,
      data: { message: { uid: `from-${chat}`, direction: "inbound", sender: owner, body: "remind me at 5", attachments: [], created_at: new Date().toISOString() } } }));
  });
  let turns = 0;
  const peers: string[] = [];
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> }; gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: ({ peer }: { peer: { id: string } }) => { peers.push(peer.id); return { sessionKey: "agent:main:main" }; } },
      inbound: { buildContext: async () => ({}), dispatch: async (dispatch: Dispatch) => {
        // The owner wrote from the Mac last; each turn still answers in the thread its message came from.
        wrote = { phone: "2026-10-30T10:00:00Z", mac: "2026-10-30T11:00:00Z" };
        dispatch.replyOptions.onAgentRunTerminalOutcome("completed");
        await dispatch.delivery.deliver({ text: "Will do." });
        if (++turns === 2) controller.abort();
        return { dispatched: true, dispatchResult: { counts: { final: 1 } } };
      } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg: {}, abortSignal: controller.signal, log: { info() {} } });
  const cfg = { channels: { plow: account } };
  // A reminder bound to the thread it was set in, and a send to the owner, both after the turn.
  await channel.outbound.sendText({ cfg, accountId: "chat", to: "plow:phone", text: "It's 5." });
  await channel.outbound.sendText({ cfg, accountId: "chat", to: "plow-owner", text: "Morning brief." });
  const posts = fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages") && (call.arguments[1] as RequestInit | undefined)?.method === "POST")
    .map(call => [String(call.arguments[0]).match(/\/chats\/([^/]+)\/messages$/)?.[1], JSON.parse((call.arguments[1] as RequestInit).body as string).body]);
  assert.deepEqual([...posts.slice(0, 2)].sort(), [["mac", "Will do."], ["phone", "Will do."]]);
  assert.deepEqual(posts.slice(2), [["mac", "It's 5."], ["mac", "Morning brief."]]);
  // Both threads' turns run in the one owner session.
  assert.deepEqual(peers, ["plow-owner", "plow-owner"]);
});
