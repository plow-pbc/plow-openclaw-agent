import assert from "node:assert/strict";
import { test } from "node:test";
import { startDeliveryRun, finishDeliveryRun, installDeliveryGuard, threadIdempotencyKey } from "../plugin/delivery-guard.ts";

for (const failure of ["exception", "result"] as const) test(`uncertain delivery blocks later Plow mutations across tool ids but isolates other runs: ${failure}`, () => {
  const hooks: Record<string, (event: any, ctx: any) => any> = {};
  installDeliveryGuard({ on(name: string, hook: any) { hooks[name] = hook; } } as any);
  startDeliveryRun("one", "inbound-one");
  startDeliveryRun("two", "inbound-two");
  try {
    const event = { toolName: "plow_start_thread", toolCallId: "call-one" };
    assert.equal(hooks.before_tool_call(event, { runId: "one" }), undefined);
    const payload = ["line", ["+15550000001", "+15550000002"], "Meet Friday?", false];
    const firstKey = threadIdempotencyKey("call-one", payload);
    hooks.after_tool_call({ ...event, result: { details: { chat_uid: "created" } } }, { runId: "one" });
    hooks.before_tool_call({ ...event, toolCallId: "call-two" }, { runId: "one" });
    assert.equal(threadIdempotencyKey("call-two", payload), firstKey, "same inbound and payload reuse the provider key despite a new tool-call id");
    const error = "Plow delivery is unknown; not replaying this send";
    hooks.after_tool_call({ ...event, toolCallId: "call-two", ...(failure === "exception" ? { error } : { result: { isError: true, content: [{ text: error }] } }) }, { runId: "one" });
    for (const toolName of ["message", "plow_start_thread", "plow_reply_to", "plow_send_email", "plow_set_thread_trust"]) {
      assert.deepEqual(hooks.before_tool_call({ toolName, runId: "one" }, {}), { block: true, blockReason: error });
      assert.equal(hooks.before_tool_call({ toolName, runId: "two" }, {}), undefined);
    }
    assert.equal(hooks.before_tool_call({ toolName: "read", runId: "one" }, {}), undefined);
    hooks.before_tool_call({ ...event, toolCallId: "other" }, { runId: "two" });
    assert.notEqual(threadIdempotencyKey("other", payload), firstKey);
    finishDeliveryRun("one");
    startDeliveryRun("one", "next-inbound");
    assert.equal(hooks.before_tool_call({ ...event, toolCallId: "next" }, { runId: "one" }), undefined);
    assert.notEqual(threadIdempotencyKey("next", payload), firstKey);
  } finally { finishDeliveryRun("one"); finishDeliveryRun("two"); }
});

test("a definite rejection does not latch and replay of one inbound source keeps the thread key", () => {
  const hooks: Record<string, (event: any, ctx: any) => any> = {};
  installDeliveryGuard({ on(name: string, hook: any) { hooks[name] = hook; } } as any);
  const bind = (runId: string, toolCallId: string) => hooks.before_tool_call({ toolName: "plow_start_thread", toolCallId, runId }, {});
  startDeliveryRun("before-restart", "same-inbound");
  bind("before-restart", "old-call");
  const key = threadIdempotencyKey("old-call", ["line", "payload"]);
  hooks.after_tool_call({ toolName: "plow_start_thread", error: "Plow HTTP 403", runId: "before-restart", toolCallId: "old-call" }, {});
  assert.equal(bind("before-restart", "retry"), undefined);
  finishDeliveryRun("before-restart");
  startDeliveryRun("after-restart", "same-inbound");
  bind("after-restart", "new-call");
  assert.equal(threadIdempotencyKey("new-call", ["line", "payload"]), key);
  finishDeliveryRun("after-restart");
});
