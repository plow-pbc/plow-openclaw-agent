import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { buildReport, MAX_FIELD } from "../plugin/report-bug.ts";

test("buildReport trims fields and carries them through verbatim", () => {
  const payload = buildReport(
    {
      trigger: "capability_gap",
      user_wanted: "  send an email  ",
      agent_could_do: "offer Latch",
      error: "no mailbox configured",
    },
    { imageRevision: "abc1234", runtime: "OpenClaw" },
    new Date("2026-10-21T18:00:00Z"),
  );
  assert.equal(payload.trigger, "capability_gap");
  // No scrubbing: the agent's own wording is sent as-is, only trimmed.
  assert.equal(payload.user_wanted, "send an email");
  assert.equal(payload.agent_could_do, "offer Latch");
  assert.equal(payload.error, "no mailbox configured");
  assert.equal(payload.image_revision, "abc1234");
  assert.equal(payload.runtime, "OpenClaw");
  assert.equal(payload.occurred_at, "2026-10-21T18:00:00.000Z");
});

test("buildReport caps an overlong field and defaults optional fields", () => {
  const longProse = "the mail app keeps failing on me ".repeat(40); // > MAX_FIELD
  assert.ok(longProse.length > MAX_FIELD);
  const payload = buildReport({ trigger: "error", user_wanted: longProse, error: "boom" }, {});
  assert.equal(payload.user_wanted.length, MAX_FIELD);
  assert.equal(payload.agent_could_do, "");
  assert.equal(payload.image_revision, null);
  assert.equal(payload.runtime, null);
});

type Tool = { name: string; description: string; execute: (id: string, args: object) => Promise<{ isError?: boolean; details: Record<string, unknown> }> };

function reportBugTool(): (context: object) => Tool {
  let factory: ((context: object) => Tool) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "report_bug") factory = value; } });
  assert.ok(factory);
  return factory;
}

// A reply may say "reported" only with the id this returns (#102): the tool must hand one back on
// success, and on failure say plainly that nothing was sent.
test("report_bug returns the report id to quote, or says the report was not sent", async t => {
  const factory = reportBugTool();
  const config = { channels: { plow: { apiBase: "http://fixture", lineUid: "line" } } };
  const args = { trigger: "capability_gap", user_wanted: "place a phone call", error: "no calling tool" };
  assert.match(factory({ config }).description, /only tell the person it was reported after this returns success.*report_id/i);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "accepted", report_id: "0123456789abcdef" }));
  assert.deepEqual((await factory({ config }).execute("call", args)).details,
    { success: true, status: "accepted", report_id: "0123456789abcdef" });
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 502 }));
  const failed = await factory({ config }).execute("call", args);
  assert.equal(failed.isError, true);
  assert.match(String(failed.details.error), /the report was not sent/);
});
