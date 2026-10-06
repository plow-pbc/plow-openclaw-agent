import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createHash } from "node:crypto";

// The channel and tool discovery can load separate copies of this module.
const key = Symbol.for("plow.delivery-guard");
type Run = { source: string; unknown: boolean; silent: boolean };
const shared = globalThis as typeof globalThis & { [key]?: { runs: Map<string, Run>; calls: Map<string, { runId: string; source: string }> } };
const { runs, calls } = shared[key] ??= { runs: new Map(), calls: new Map() };
const mutations = new Set(["message", "plow_start_thread", "plow_reply_to", "plow_send_email", "plow_set_thread_trust"]);
const unknown = "Plow delivery is unknown; not replaying this send";

export function startDeliveryRun(runId: string, source: string) { runs.set(runId, { source, unknown: false, silent: false }); }
export function deliveryRunIsUnknown(runId: string) { return runs.get(runId)?.unknown === true; }
export function deliveryRunIsSilent(runId: string) { return runs.get(runId)?.silent === true; }
export function finishDeliveryRun(runId: string) {
  runs.delete(runId);
  for (const [id, call] of calls) if (call.runId === runId) calls.delete(id);
}
export function threadIdempotencyKey(callId: string, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify([calls.get(callId)?.source ?? callId, payload])).digest("hex");
}
export function installDeliveryGuard(api: Pick<OpenClawPluginApi, "on">) {
  api.on("before_tool_call", (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    const run = runId === undefined ? undefined : runs.get(runId);
    if (!run || !mutations.has(event.toolName) || (event.toolName === "plow_send_email" && event.params?.action === "list")) return;
    if (run.unknown) return { block: true, blockReason: unknown };
    const callId = event.toolCallId ?? ctx.toolCallId;
    if (callId && event.toolName === "plow_start_thread") calls.set(callId, { runId: runId!, source: run.source });
  });
  api.on("after_tool_call", (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    const run = runId === undefined ? undefined : runs.get(runId);
    const callId = event.toolCallId ?? ctx.toolCallId;
    if (callId) calls.delete(callId);
    if (!run) return;
    const result = event.result as { isError?: boolean; details?: { silent?: boolean }; content?: { text?: string }[] } | undefined;
    if (typeof result?.details?.silent === "boolean") run.silent = result.details.silent;
    if (!mutations.has(event.toolName)) return;
    const error = event.error ?? (result?.isError ? result.content?.map(part => part.text ?? "").join("\n") : "");
    if (error?.includes(unknown)) run.unknown = true;
  });
}
