import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

// plow-openclaw-agent#122: a group answer the model left in its private final text reaches nobody, so the plugin
// gives the model one follow-up turn with that text. Each run below is what OpenClaw does for one dispatch.
type Run = { final: string; posted?: boolean };
type Ctx = { messageId: string; supplemental: { groupSystemPrompt?: string; channelStructuredContext: { type: string; payload: { text?: string } }[] } };

async function groupTurn(t: TestContext, runs: Run[], { tagged = false, direct = false } = {}) {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter(5000);
  const account = { apiBase, accountId: "chat", lineUid: "line", threadTrust: "ask" };
  const cfg = { channels: { plow: account }, messages: { groupChat: { unmentionedInbound: "room_event" } } };
  const self = { type: "agent", relationship: "self", line: { uid: "line" } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const member = { ...owner, uid: "member", role: "member", display_name: "Joe", provider_key: "+15550000002" };
  const home = { uid: "cht_home", status: "active", trusted: true, participants: [self, owner] };
  const chat = direct ? home : { uid: "cht_group", status: "active", trusted: true, participants: [self, owner, member] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: direct ? [home] : [home, chat], has_more: false } : url.endsWith(`/chats/${chat.uid}`) ? chat
      : url.endsWith("/chats/cht_home") ? home : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "inbound", chat_id: chat.uid,
    data: { message: { uid: "inbound", direction: "inbound", sender: owner, body: "What's 15% of 240?", attachments: [],
      mentions: tagged ? [{ handle: "+15550000009", is_me: true }] : null, created_at: new Date().toISOString() } },
  })));
  const hooks = new Map<string, (event: object, ctx: object) => unknown>();
  const dispatched: Ctx[] = [];
  let idle: ReturnType<typeof setTimeout> | undefined;
  const runtime = { channel: {
    routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: `agent:main:plow:${direct ? "direct" : "group"}:${chat.uid}` }) },
    session: { resolveStorePath, updateLastRoute },
    inbound: {
      buildContext: async (input: Ctx) => input,
      dispatch: async ({ ctxPayload, replyOptions }: { ctxPayload: Ctx; replyOptions: { onAgentRunStart: (runId: string) => void; onAgentRunTerminalOutcome: (outcome: string) => void } }) => {
        const run = runs[dispatched.length] ?? { final: "NO_REPLY" };
        const runId = `run-${dispatched.length}`;
        dispatched.push(ctxPayload);
        replyOptions.onAgentRunStart(runId);
        if (run.posted) hooks.get("after_tool_call")!({ runId, toolName: "message", result: {} }, {});
        hooks.get("before_agent_finalize")!({ runId, lastAssistantMessage: run.final }, {});
        replyOptions.onAgentRunTerminalOutcome("completed");
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), 300);
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      },
    },
  } };
  let channel: { gateway: { startAccount: (context: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", runtime, logger: { info() {} }, registerTool() {},
    on(name: string, handler: (event: object, ctx: object) => unknown) { hooks.set(name, handler); },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  await channel!.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  return dispatched;
}

test("an answer left in a group's private final gets one follow-up turn that shows the model that text", async t => {
  const answer = "15% of 240 is 36.";
  const dispatched = await groupTurn(t, [{ final: answer }, { final: "Sent it." }]);
  // The follow-up's own private final starts nothing further.
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].messageId, "inbound");
  assert.equal(dispatched[0].supplemental.groupSystemPrompt, undefined);
  assert.equal(dispatched[1].messageId, "inbound:private-final");
  assert.match(dispatched[1].supplemental.groupSystemPrompt!, /stayed private: nobody in the group saw it/);
  assert.deepEqual(dispatched[1].supplemental.channelStructuredContext.filter(entry => entry.type === "private_final").map(entry => entry.payload),
    [{ text: answer }]);
});

for (const [name, runs, options] of [
  ["the message tool posted", [{ final: "Answered above.", posted: true }], {}],
  ["the final is the silence marker", [{ final: "NO_REPLY" }], {}],
  ["the final is empty", [{ final: "" }], {}],
  ["the text tagged the agent, so its final was posted", [{ final: "15% of 240 is 36." }], { tagged: true }],
  ["it is a direct chat", [{ final: "15% of 240 is 36." }], { direct: true }],
] as const) test(`no follow-up turn when ${name}`, async t => {
  assert.equal((await groupTurn(t, [...runs], options)).length, 1);
});
