import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import entry from "../plugin/index.ts";

type Tool = { name: string; parameters?: object; execute: (id: string, args: object) => Promise<unknown> };

test("plow_start_thread takes phone numbers and iMessage emails as members, as Plow does", () => {
  let tool: Tool | undefined;
  entry.register({ registrationMode: "full", logger: { info() {} }, runtime: {}, registerChannel() {},
    registerTool(factory: (context: object) => Tool) {
      const candidate = factory({});
      if (candidate.name === "plow_start_thread") tool = candidate;
    },
  });
  const check = (members: string[]) => validateToolArguments(tool as never, { type: "toolCall", id: "call", name: "plow_start_thread", arguments: { members, body: "Meet Friday?" } } as never);
  assert.doesNotThrow(() => check(["+15550000002", "joe@icloud.com"]));
  for (const member of ["5550000002", "joe", "joe@", "@icloud.com", "joe @icloud.com", "cht_home"]) {
    assert.throws(() => check([member]), /Validation failed/, member);
  }
});

test("collected owner tools resolve the host delivery route and still refuse other callers or conversations", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const cfg = { channels: { plow: { apiBase: "http://fixture", accountId: "chat", lineUid: "line", threadTrust: "ask" } } };
  const owner = { type: "member", uid: "owner", role: "owner", provider_key: "Owner@Example.test" };
  const home = { uid: "home", status: "active", trusted: true, participants: [owner,
    { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const posts: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body as string));
      return Response.json({ uid: "created" });
    }
    return Response.json(url.endsWith("/home") ? home : { ...home, uid: "group", participants: [...home.participants, { ...owner, uid: "member", role: "member" }] });
  });
  for (const scenario of ["owner", "non-owner", "other-conversation"] as const) {
    let tool: Tool;
    entry.register({ registrationMode: "full", logger: { info() {} }, runtime: {}, registerChannel() {},
      registerTool(factory: (context: object) => Tool) {
        const candidate = factory({ config: cfg, sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat",
          requesterSenderId: scenario === "non-owner" ? "+15550000002" : "plow-owner", senderIsOwner: scenario !== "non-owner",
          deliveryContext: { channel: "plow", accountId: "chat", to: `plow:${scenario === "other-conversation" ? "group" : "home"}` } });
        if (candidate.name === "plow_start_thread") tool = candidate;
      },
    });
    const invoke = () => tool.execute("collected-call", { members: ["+15550000002", "owner@example.test", "Guest@Example.test", "guest@example.test"], body: "Meet Friday?", trusted: false });
    if (scenario === "owner") assert.deepEqual((await invoke() as { details: unknown }).details, { chat_uid: "created", message_sent: true });
    else await assert.rejects(invoke(), /requires the owner's main Plow DM/);
  }
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].members, ["+15550000002", "guest@example.test", "owner@example.test"]);
});

for (const toolName of ["plow_start_thread", "message"]) {
  for (const status of [200, 403, 408, 424, 503, "network"] as const) test(`${toolName}: delivery errors and tool-call idempotency, status=${status}`, async t => {
    process.env.PLOW_AGENT_TOKEN = "test-token";
    const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line", threadTrust: "ask" };
    const cfg = { channels: { plow: account } };
    const chat = { uid: "home", status: "active", trusted: true, participants: [
      { type: "member", uid: "owner", role: "owner", provider_key: "+15550000001" },
      { type: "agent", relationship: "self", line: { uid: "line" } },
    ] };
    const posts: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
      if (options.method === "POST") {
        posts.push(JSON.parse(options.body as string));
        if (status === "network") throw new TypeError("network error");
        return Response.json({ uid: "created" }, { status });
      }
      return Response.json(chat);
    });
    let tool: Tool, outbound: { sendText: (context: object) => Promise<unknown> };
    entry.register({ registrationMode: "full", logger: { info() {} }, runtime: {},
      registerChannel(value: { plugin: { outbound: typeof outbound } }) { outbound = value.plugin.outbound; },
      registerTool(factory: (context: object) => Tool) {
        const candidate = factory({ config: cfg, sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "home", requesterSenderId: "plow-owner", senderIsOwner: true });
        if (candidate.name === toolName) tool = candidate;
      },
    });
    const invoke = (id: string, members: string[]) => toolName === "message"
      ? outbound.sendText({ cfg, accountId: "chat", to: "home", text: "Meet Friday?" })
      : tool.execute(id, { members, body: "Meet Friday?", trusted: false });
    for (const [id, members] of [
      ["call-1", ["+15550000002", "+15550000001"]],
      ["call-1", ["+15550000001", "+15550000002"]],
      ["call-2", ["+15550000002"]],
    ] as const) {
      if (status === 200) {
        const result = await invoke(id, [...members]);
        if (toolName === "plow_start_thread") assert.deepEqual((result as { details: unknown }).details, { chat_uid: "created", message_sent: true });
      } else await assert.rejects(invoke(id, [...members]), status === 403 ? /HTTP 403/ : /delivery is unknown/);
    }
    assert.equal(posts.length, 3, "each explicit invocation reaches the API; uncertain sends are never automatically retried");
    if (toolName === "plow_start_thread") {
      assert.deepEqual(posts[0].members, ["+15550000001", "+15550000002"]);
      assert.equal(posts[0].trusted, false);
      assert.equal(posts[0].line_uid, "line");
      assert.equal(posts[0].body, "Meet Friday?");
      assert.equal(posts[0].idempotency_key, posts[1].idempotency_key);
      assert.notEqual(posts[0].idempotency_key, posts[2].idempotency_key);
    }
  });
}

test("an iMessage email can start a new untrusted group without a Contacts lookup", async t => {
  const { startThread } = await import("../plugin/threads.ts");
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line", threadTrust: "untrusted" as const };
  const home = { uid: "home", status: "active", trusted: true, participants: [
    { type: "member", uid: "owner", role: "owner", provider_key: "+15550000001" },
    { type: "agent", relationship: "self", line: { uid: "line" } },
  ] };
  const posts: { members: string[]; trusted: boolean; idempotency_key: string }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    if (options.method === "POST") { posts.push(JSON.parse(options.body as string)); return Response.json({ uid: "group" }); }
    return Response.json(home);
  });
  const context = { sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "home", requesterSenderId: "plow-owner", senderIsOwner: true };
  await startThread(account, context, "stable-call", { members: ["Taylor@example.test"], body: "Meet Friday?", trusted: true });
  await startThread(account, context, "stable-call", { members: ["taylor@example.test"], body: "Meet Friday?" });
  assert.deepEqual(posts[0]?.members, ["+15550000001", "taylor@example.test"]);
  assert.equal(posts[0]?.trusted, false);
  assert.equal(posts[0]?.idempotency_key, posts[1]?.idempotency_key);
  await assert.rejects(startThread(account, { ...context, senderIsOwner: false }, "guest", { members: ["taylor@example.test"], body: "Meet?" }), /owner/);
});
