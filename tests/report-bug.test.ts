import assert from "node:assert/strict";
import { test } from "node:test";
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
