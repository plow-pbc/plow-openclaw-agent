import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConfig } from "../boot/config.ts";
import { installExperienceTools } from "../plugin/experience.ts";

test("only the reserved worker's automatic terminal notice is suppressed", async () => {
  const { n: shouldAutoDeliverTaskTerminalUpdate } = await import("/app/dist/task-notification-policy-7pB-BxLh.mjs");
  const task = { runtime: "subagent", status: "cancelled", notifyPolicy: "done_only", deliveryStatus: "pending" };
  assert.equal(shouldAutoDeliverTaskTerminalUpdate({ ...task, childSessionKey: "agent:plow-worker:subagent:owned" }), false);
  assert.equal(shouldAutoDeliverTaskTerminalUpdate({ ...task, childSessionKey: "agent:another-worker:subagent:owned" }), true);
  assert.equal(shouldAutoDeliverTaskTerminalUpdate({ ...task, childSessionKey: "agent:main:subagent:owned" }), true);
  assert.equal(shouldAutoDeliverTaskTerminalUpdate({ ...task, runtime: "acp", childSessionKey: "agent:plow-worker:subagent:owned" }), true);
  assert.equal(shouldAutoDeliverTaskTerminalUpdate({ ...task, notifyPolicy: "silent" }), false);
});

test("the native worker policy excludes messaging, private state and mutation tools", async () => {
  const { filterToolsByPolicy } = await import("/app/dist/tool-policy-match-CgrEQaD6.mjs");
  const config = renderConfig({ agent: { name: "Cedar" }, line: { uid: "ln_test" }, chats: [] }, "http://fixture");
  const offered = ["message", "plow_reply_to", "plow_memory", "automations", "exec", "read", "sessions_spawn", "web_fetch", "web_search"].map(name => ({ name }));
  assert.deepEqual(filterToolsByPolicy(offered, config.agents.entries["plow-worker"].tools).map((tool: { name: string }) => tool.name), ["web_fetch", "web_search"]);
  assert.deepEqual(config.agents.entries.main.subagents.allowAgents, ["plow-worker"]);
});

test("worker effect guards reject messages and mutations even if another policy grants them", async () => {
  let hook: any;
  installExperienceTools({ registerTool() {}, on(name: string, callback: unknown) { if (name === "before_tool_call") hook = callback; } } as any, () => { throw new Error("unused"); });
  for (const toolName of ["message", "plow_send_email", "plow_memory", "automations", "exec", "sessions_spawn"]) {
    assert.equal((await hook({ toolName, params: { agentId: "main" } }, { agentId: "plow-worker" })).block, true);
  }
  assert.equal(await hook({ toolName: "web_fetch", params: {} }, { agentId: "plow-worker" }), undefined);
  assert.equal((await hook({ toolName: "sessions_spawn", params: { agentId: "main" } }, { agentId: "main" })).block, true);
  assert.equal((await hook({ toolName: "sessions_spawn", params: { agentId: "plow-worker", runtime: "acp" } }, { agentId: "main" })).block, true);
  assert.equal(await hook({ toolName: "sessions_spawn", params: { agentId: "plow-worker" } }, { agentId: "main" }), undefined);
});
