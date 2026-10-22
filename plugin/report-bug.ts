/*
 * report_bug payload assembly.
 *
 * Keeping personal data out of a report is the agent's own judgment: the tool
 * description and prompt tell the model to describe the situation generically
 * and leave out contacts, numbers, addresses and tokens. There is no regex
 * scrub — the agent is trusted not to leak its owner's data about itself. This
 * module only trims and length-caps the fields. Kept SDK-free so it unit-tests
 * without the plugin runtime.
 */

// Matches the API's per-field cap (api/plow/routes/bug_report.py); slicing here
// keeps a long report from being rejected rather than silently dropped.
export const MAX_FIELD = 600;

export type BugTrigger = "capability_gap" | "error" | "user_report";

// The server identifies the calling agent from its credential, so the payload
// carries only what the server cannot know: the running image and runtime.
export type BugReportIdentity = {
  imageRevision?: string;
  runtime?: string;
};

export type BugReportPayload = {
  trigger: BugTrigger;
  user_wanted: string;
  agent_could_do: string;
  error: string;
  image_revision: string | null;
  runtime: string | null;
  occurred_at: string;
};

function field(text: string | undefined): string {
  return (text ?? "").trim().slice(0, MAX_FIELD);
}

// Matches the API's feedback cap (MAX_TOTAL in api/plow/routes/bug_report.py).
export const MAX_FEEDBACK = 1500;

export type FeedbackPayload = {
  feedback: string;
  image_revision: string | null;
  runtime: string | null;
  occurred_at: string;
};

/** Feedback (thanks, praise, an idea) for POST /v1/agents/feedback, trimmed and capped. */
export function buildFeedback(feedback: string, identity: BugReportIdentity, now: Date = new Date()): FeedbackPayload {
  return {
    feedback: feedback.trim().slice(0, MAX_FEEDBACK),
    image_revision: identity.imageRevision ?? null,
    runtime: identity.runtime ?? null,
    occurred_at: now.toISOString(),
  };
}

/** Assemble the report into the API payload, fields trimmed and length-capped. */
export function buildReport(
  args: { trigger: BugTrigger; user_wanted: string; agent_could_do?: string; error: string },
  identity: BugReportIdentity,
  now: Date = new Date(),
): BugReportPayload {
  return {
    trigger: args.trigger,
    user_wanted: field(args.user_wanted),
    agent_could_do: field(args.agent_could_do),
    error: field(args.error),
    image_revision: identity.imageRevision ?? null,
    runtime: identity.runtime ?? null,
    occurred_at: now.toISOString(),
  };
}
