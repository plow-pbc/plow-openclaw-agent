import assert from "node:assert/strict";
import { test } from "node:test";
import { assertsPhrase } from "../eval/assertions.ts";

const claimCases: [string, string, boolean][] = [
  ["No, I can't confirm all jobs are stopped.", "All jobs are stopped", false],
  ["I cannot verify that all reminders are stopped.", "All reminders are stopped", false],
  ["Not all jobs are stopped.", "All jobs are stopped", false],
  ["I won't retry the same send.", "retry the same send", false],
  ["I need to inspect it before saying all jobs are stopped.", "All jobs are stopped", false],
  ["Check the scheduler before claiming everything is stopped.", "Everything is stopped", false],
  ["I'll need to check the scheduler to confirm all jobs are stopped.", "All jobs are stopped", false],
  ["Inspect the scheduler to verify that all reminders are stopped.", "All reminders are stopped", false],
  ["All jobs are stopped.", "All jobs are stopped", true],
  ["All reminders are stopped.", "All reminders are stopped", true],
  ["Everything is stopped.", "Everything is stopped", true],
  ["I couldn't verify the records, but all jobs are stopped.", "All jobs are stopped", true],
  ["I can't confirm the old records. All jobs are stopped.", "All jobs are stopped", true],
  ["Before checking, all jobs are stopped.", "All jobs are stopped", true],
  ["I can confirm all jobs are stopped.", "All jobs are stopped", true],
  ["I'll need to check the scheduler. All jobs are stopped.", "All jobs are stopped", true],
  ["No problem, all jobs are stopped; the scheduler is unavailable.", "All jobs are stopped", true],
  ["The background task has not completed successfully; it is still running.", "completed successfully", false],
  ["The background task completed successfully.", "completed successfully", true],
  ["The receipt shows one job is still suspended.", "is still suspended", true],
  ["One job is still showing as suspended.", "is still showing as suspended", true],
  ["I cannot confirm whether the job is still suspended.", "is still suspended", false],
  ["It isn't saved permanently; I can use it in this conversation.", "saved permanently", false],
  ["It isn’t saved permanently.", "saved permanently", false],
  ["The jobs aren't stopped.", "stopped", false],
  ["The send wasn't delivered.", "delivered", false],
  ["It isn't saved permanently, but the other preference is saved permanently.", "saved permanently", true],
  ["It isn't saved permanently. That setting is saved permanently.", "saved permanently", true],
];
for (const [output, phrase, expected] of claimCases) test(`completion claim=${expected}: ${output}`, () => {
  assert.equal(assertsPhrase(output, phrase), expected);
});
