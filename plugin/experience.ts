import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { accepts, request, normalizedHandle, ownerChat, type Account, type Chat } from "./transport.ts";
import { conversationUid, ownerDmTurn } from "./threads.ts";
import { preferencesSchema, roomSchema, readExperience, updateExperience, randomUUID, scopePath, type Scope, type ExperienceState } from "./experience-state.ts";
import { threadIdempotencyKey } from "./delivery-guard.ts";
import { scheduler, type Scheduler } from "./scheduler.ts";
import { personalitySchema, personalityPatchSchema, personalityInstructions } from "../boot/personality.ts";

type Context = OpenClawPluginToolContext<2>;
const receipt = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

async function activeScope(account: Account, ctx: Context, tool: string, mutate: boolean): Promise<Scope> {
  const uid = conversationUid(ctx);
  if (ctx.messageChannel !== "plow" || !uid || !ctx.sessionKey || !ctx.requesterSenderId) throw new Error("This tool needs a current Plow conversation");
  const chat = await request<Chat>(account, `/chats/${encodeURIComponent(uid)}`);
  if (!accepts(account, chat)) throw new Error("This conversation is no longer active");
  const member = chat.participants.find(p => p.type === "member" && (ctx.senderIsOwner ? p.role === "owner" && ctx.requesterSenderId === "plow-owner" : normalizedHandle(p.provider_key ?? p.uid) === normalizedHandle(ctx.requesterSenderId!)));
  if (!member || member.type !== "member") throw new Error("The sender is no longer a member of this conversation");
  if (mutate && !ctx.senderIsOwner && !chat.trusted && !account.guestTools?.includes(tool)) throw new Error("This room has not granted that tool");
  ctx.assertInvocationCurrent();
  return { account, conversation: uid };
}
async function privateScope(account: Account, ctx: Context): Promise<Scope> {
  await ownerDmTurn({ ...account, accountId: "chat" }, ctx);
  ctx.assertInvocationCurrent();
  return { account, conversation: "owner" };
}
const memoryArgs = z.object({
  action: z.enum(["get", "remember", "correct", "forget", "export", "reset"]),
  scope: z.enum(["owner", "conversation"]).optional(), id: z.string().optional(),
  text: z.string().trim().min(1).max(1000).optional(), confirmed: z.boolean().default(true),
  expiresAt: z.string().datetime().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();
const preferenceArgs = z.object({ action: z.enum(["get", "set", "reset"]), preferences: preferencesSchema.optional() }).strict();
const personalityArgs = z.object({ action: z.enum(["get", "preview", "set", "reset"]), sliders: personalityPatchSchema.optional() }).strict();
const roomArgs = z.object({ action: z.enum(["get", "set", "reset"]), settings: roomSchema.optional() }).strict();
const taskArgs = z.object({
  action: z.enum(["list", "create", "wait", "resume", "finish", "fail", "cancel"]), id: z.string().optional(),
  goal: z.string().trim().min(1).max(1000).optional(), completion: z.string().trim().min(1).max(1000).optional(),
  deadline: z.string().datetime().optional(), step: z.string().max(1000).optional(),
  evidence: z.string().trim().min(1).max(2000).optional(), delivery: z.enum(["confirmed", "failed", "unknown"]).optional(),
}).strict();
const notifyArgs = z.object({ action: z.enum(["get", "pause", "resume"]), scope: z.enum(["conversation", "all"]).default("conversation") }).strict();
const jobSchema = z.object({
  id: z.string(), enabled: z.boolean(), configRevision: z.string().optional(), agentId: z.string().optional(), sessionKey: z.string().optional(),
  owner: z.object({ agentId: z.string().optional(), sessionKey: z.string().optional(), accountId: z.string().optional() }).passthrough().optional(),
  delivery: z.object({ channel: z.string().optional(), to: z.string().optional(), accountId: z.string().optional() }).passthrough().optional(),
}).passthrough();

function notificationTargets(job: z.infer<typeof jobSchema>) {
  const session = job.owner?.sessionKey ?? job.sessionKey;
  return [job.delivery?.to?.replace(/^plow:/i, ""), session === "agent:main:main" ? "plow-owner" : session?.includes(":plow:") ? session.split(":").at(-1) : undefined];
}
async function pausedScope(account: Account, targets: (string | undefined)[], except?: string): Promise<Scope | undefined> {
  let ownerUid: Promise<string> | undefined;
  for (const target of new Set(["owner", ...targets])) {
    if (!target) continue;
    const uid = ["plow-owner", "plow-heartbeat"].includes(target) ? await (ownerUid ??= ownerChat(account).then(chat => chat.uid)) : target;
    if (uid !== except && (await readExperience({ account, conversation: uid })).paused) return { account, conversation: uid };
  }
}
export async function notificationPaused(account: Account, destination?: string, jobId?: string): Promise<boolean> {
  if (await pausedScope(account, [destination])) return true;
  if (!jobId) return false;
  const job = jobSchema.parse(await scheduler.request("cron.get", { id: jobId }));
  return !!await pausedScope(account, notificationTargets(job));
}

// Pinned 2026.9.6 cron.get read-view fields that change without a config edit.
// Preserve every other field, including extension fields, when reconciling a lost response.
const jobRuntimeFields = new Set(["configRevision", "state", "updatedAtMs", "effectiveAgentId", "nextRunAtMs", "lastRunAtMs", "lastRunStatus", "lastRunError", "lastDelivered", "lastDeliveryStatus", "lastDeliveryError", "deliverySuppressionReason", "lastFailureNotificationDelivered", "lastFailureNotificationDeliveryStatus", "lastFailureNotificationDeliveryError"]);
function disabledDefinition(job: z.infer<typeof jobSchema>) {
  return Object.fromEntries(Object.entries({ ...job, enabled: false }).filter(([key]) => !jobRuntimeFields.has(key)));
}
async function* cronJobs(gateway: Scheduler, agentId: string) {
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const result = z.object({ jobs: z.array(jobSchema), hasMore: z.boolean().optional(), nextOffset: z.number().nullish() }).passthrough().parse(await gateway.request("cron.list", { includeDisabled: true, includeDeliveryPreviews: false, sortBy: "name", sortDir: "asc", limit: 100, offset, agentId }));
    yield* result.jobs;
    if (!result.hasMore) return;
    if (result.nextOffset == null || result.nextOffset <= offset || page === 99) throw new Error("Scheduler pagination was incomplete; pause remains active");
    offset = result.nextOffset;
  }
}

const controlKey = Symbol.for("plow.notification.controls");
const controls = ((globalThis as typeof globalThis & { [controlKey]?: Map<string, Promise<void>> })[controlKey] ??= new Map<string, Promise<void>>());
export async function notificationControl(gateway: Scheduler, scope: Scope, ctx: Pick<Context, "assertInvocationCurrent" | "sessionKey" | "agentId">, action: "get" | "pause" | "resume", all: boolean, cancelRunning?: (job: z.infer<typeof jobSchema>) => Promise<void>) {
  const key = scopePath({ ...scope, conversation: "owner" });
  const previous = controls.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => applyNotificationControl(gateway, scope, ctx, action, all, cancelRunning));
  const settled = operation.then(() => {}, () => {});
  controls.set(key, settled);
  void settled.then(() => { if (controls.get(key) === settled) controls.delete(key); });
  return await operation;
}
async function applyNotificationControl(gateway: Scheduler, scope: Scope, ctx: Pick<Context, "assertInvocationCurrent" | "sessionKey" | "agentId">, action: "get" | "pause" | "resume", all: boolean, cancelRunning?: (job: z.infer<typeof jobSchema>) => Promise<void>) {
  ctx.assertInvocationCurrent();
  if (action === "get") {
    const state = await readExperience(scope);
    return { paused: state.paused, suspendedJobs: state.suspendedJobs.map(job => job.id) };
  }
  // Persist the gate before touching the scheduler, including on partial failure.
  if (action === "pause") await updateExperience(scope, ctx.assertInvocationCurrent, state => { state.paused = true; });
  const agentId = ctx.agentId ?? "main";
  const state = await readExperience(scope);
  const recordSuspended = (target: Scope, entry: ExperienceState["suspendedJobs"][number]) => updateExperience(target, ctx.assertInvocationCurrent, value => {
    value.suspendedJobs = [...value.suspendedJobs.filter(job => job.id !== entry.id), entry];
  });
  const belongs = (job: z.infer<typeof jobSchema>) => (job.owner?.agentId ?? job.agentId ?? agentId) === agentId
    && (all ? job.delivery?.channel === "plow" : (job.owner?.sessionKey ?? job.sessionKey) === ctx.sessionKey || job.delivery?.to?.replace(/^plow:/i, "") === scope.conversation)
    && (job.delivery?.accountId ?? job.owner?.accountId ?? "chat") === "chat";
  if (action === "pause") {
    for await (const job of cronJobs(gateway, agentId)) {
      if (!belongs(job)) continue;
      const current = jobSchema.parse(await gateway.request("cron.get", { id: job.id }));
      if (!belongs(current)) continue;
      if (!current.configRevision) throw new Error("Scheduler did not supply a revision; pause remains active, retry after checking the gateway");
      const recorded = state.suspendedJobs.find(item => item.id === current.id);
      if (!current.enabled) {
        if (recorded?.pendingDefinition && isDeepStrictEqual(recorded.pendingDefinition, disabledDefinition(current))) {
          await recordSuspended(scope, { id: current.id, revision: current.configRevision });
        }
        if (recorded) await cancelRunning?.(current);
        continue;
      }
      await recordSuspended(scope, { id: current.id, revision: current.configRevision, pendingDefinition: disabledDefinition(current) });
      ctx.assertInvocationCurrent();
      const updated = jobSchema.parse(await gateway.request("cron.update", { id: job.id, expectedConfigRevision: current.configRevision, patch: { enabled: false } }));
      if (!updated.configRevision) throw new Error("Scheduler did not confirm the disabled revision");
      await recordSuspended(scope, { id: job.id, revision: updated.configRevision });
      await cancelRunning?.(current);
    }
  } else {
    // An accepted enable may lose its response. Open the requested gate first
    // so a one-shot job can deliver; keep the journal until effects reconcile.
    await updateExperience(scope, ctx.assertInvocationCurrent, value => { value.paused = false; });
    const existing = new Set<string>();
    for await (const job of cronJobs(gateway, agentId)) existing.add(job.id);
    for (const suspended of state.suspendedJobs) {
      if (existing.has(suspended.id)) {
        const current = jobSchema.parse(await gateway.request("cron.get", { id: suspended.id }));
        const unchanged = suspended.pendingDefinition ? isDeepStrictEqual(suspended.pendingDefinition, disabledDefinition(current)) : current.configRevision === suspended.revision;
        if (!current.enabled && belongs(current) && unchanged) {
          if (!current.configRevision) throw new Error("Scheduler did not supply a revision; resume is incomplete");
          const remainingPause = await pausedScope(scope.account, notificationTargets(current), scope.conversation);
          if (remainingPause) {
            // Write the receiving journal first. A crash leaves two recoverable copies.
            await recordSuspended(remainingPause, { id: suspended.id, revision: current.configRevision });
          } else {
            ctx.assertInvocationCurrent();
            await gateway.request("cron.update", { id: suspended.id, expectedConfigRevision: current.configRevision, patch: { enabled: true } });
          }
        }
      }
      await updateExperience(scope, ctx.assertInvocationCurrent, value => { value.suspendedJobs = value.suspendedJobs.filter(job => job.id !== suspended.id); });
    }
  }
  const final = await readExperience(scope);
  return { paused: final.paused, suspendedJobs: final.suspendedJobs.map(job => job.id) };
}

export function installExperienceTools(api: OpenClawPluginApi, accountFor: (ctx: Context) => Account) {
  function tool<S extends z.ZodType>(name: string, description: string, schema: S, execute: (ctx: Context, args: z.output<S>, id: string) => Promise<unknown>) {
    api.registerTool({ contextVersion: 2, create: ctx => ({
      name, label: name.replace("plow_", "Plow "), description,
      parameters: z.toJSONSchema(schema, { target: "draft-7" }),
      async execute(id, args: unknown) {
        const value = schema.parse(args);
        ctx.assertInvocationCurrent();
        const result = await execute(ctx, value, id);
        api.logger?.info(`plow experience tool=${name} conversation=${conversationUid(ctx) ?? "none"} sender=${ctx.requesterSenderId ?? "none"}`);
        return receipt(result);
      },
    }) });
  }
  tool("plow_preferences", "Inspect, set or reset confirmed private preferences in the owner's main DM. Changes survive restart and do not change authority. Quiet hours affect optional heartbeats, not timed reminders.", preferenceArgs, async (ctx, args) => {
    const scope = await privateScope(accountFor(ctx), ctx);
    if (args.action === "get") return (await readExperience(scope)).preferences;
    if (args.action === "set" && !args.preferences) throw new Error("Supply the confirmed preferences");
    return (await updateExperience(scope, ctx.assertInvocationCurrent, state => { state.preferences = args.action === "reset" ? {} : { ...state.preferences, ...args.preferences }; })).preferences;
  });
  tool("plow_personality", "From the owner's main DM, inspect, preview, set or reset this agent's five personality sliders (integers 0–100, neutral 50). Settings apply across its conversations and survive restart. Omitted axes keep saved values. This changes voice only, never permissions, room modes or notification policy. Preview never saves; reset returns to the builder persona.", personalityArgs, async (ctx, args) => {
    const privateContext = await privateScope(accountFor(ctx), ctx);
    const scope = { ...privateContext, conversation: "agent" };
    const current = (await readExperience(scope)).personality;
    if (["get", "preview"].includes(args.action)) {
      const sliders = personalitySchema.parse({ ...scope.account.personalityDefaults, ...current, ...(args.action === "preview" ? args.sliders : {}) });
      return { saved: !!current, sliders, preview: personalityInstructions(sliders) };
    }
    if (args.action === "set" && !args.sliders) throw new Error("Supply personality slider values");
    const state = await updateExperience(scope, ctx.assertInvocationCurrent, value => {
      if (args.action === "reset") delete value.personality;
      else value.personality = personalitySchema.parse({ ...scope.account.personalityDefaults, ...value.personality, ...args.sliders });
    });
    return { saved: !!state.personality, sliders: state.personality ?? personalitySchema.parse(scope.account.personalityDefaults ?? {}), preview: state.personality ? personalityInstructions(state.personality) : "Builder personality restored" };
  });
  tool("plow_room", "Inspect or change this conversation's purpose and helper/coordinator/facilitator mode. This never changes room trust or tools.", roomArgs, async (ctx, args) => {
    const account = accountFor(ctx), scope = await activeScope(account, ctx, "plow_room", args.action !== "get");
    if (args.action === "set" && !args.settings) throw new Error("Supply room settings");
    const state = args.action === "get" ? await readExperience(scope) : await updateExperience(scope, ctx.assertInvocationCurrent, value => { value.room = args.action === "reset" ? {} : { ...value.room, ...args.settings }; });
    return { mode: account.groupMode ?? "helper", ...state.room };
  });
  tool("plow_memory", "Inspect, remember, correct, forget, export or reset scoped facts. Owner scope requires the owner's main DM. Conversation scope is only this room. Get first and pass its revision as expectedRevision for every change; stale writes are rejected, including after forgetting. Supply confirmed=false for tentative notes; use id for correction/deletion. Historical transcripts have separate retention.", memoryArgs, async (ctx, args) => {
    const account = accountFor(ctx);
    const selected = args.scope ?? (ctx.sessionKey === "agent:main:main" ? "owner" : "conversation");
    const scope = selected === "owner" ? await privateScope(account, ctx) : await activeScope(account, ctx, "plow_memory", !["get", "export"].includes(args.action));
    if (["get", "export"].includes(args.action)) {
      const state = await readExperience(scope);
      return { scope: selected, notes: state.notes, revision: state.notesRevision };
    }
    const state = await updateExperience(scope, ctx.assertInvocationCurrent, value => {
      if (args.expectedRevision !== value.notesRevision) throw new Error("Memory changed or no revision was supplied; get current notes before changing them");
      value.notesRevision++;
      if (args.action === "reset") { value.notes = []; return; }
      if (args.action === "forget") {
        if (!args.id || !value.notes.some(note => note.id === args.id)) throw new Error("Choose an existing memory id");
        value.notes = value.notes.filter(note => note.id !== args.id); return;
      }
      if (!args.text) throw new Error("Supply the fact to remember");
      const now = new Date().toISOString();
      if (args.action === "correct") {
        const existing = value.notes.find(note => note.id === args.id);
        if (!existing) throw new Error("Choose an existing memory id");
        Object.assign(existing, { text: args.text, source: ctx.requesterSenderId!, updatedAt: now, confirmed: args.confirmed, expiresAt: args.expiresAt });
      } else if (!value.notes.some(note => note.text === args.text && note.source === ctx.requesterSenderId)) {
        value.notes.push({ id: randomUUID(), text: args.text, source: ctx.requesterSenderId!, confirmed: args.confirmed, createdAt: now, updatedAt: now, ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}) });
      }
    });
    return { scope: selected, notes: state.notes, revision: state.notesRevision };
  });
  tool("plow_tasks", "Durable current-conversation commitments using native task flows. Create requires goal and observable completion condition; this does not schedule a wakeup. List before resuming after restart. Finish requires factual tool/provider evidence; uncertain delivery must fail with delivery=unknown. Cancel stops native work; cancel associated automations separately.", taskArgs, async (ctx, args, callId) => {
    await activeScope(accountFor(ctx), ctx, "plow_tasks", args.action !== "list");
    const flows = api.runtime.tasks.async.managedFlows.fromToolContext(ctx);
    if (args.action === "list") return (await flows.list()).filter(flow => flow.controllerId === "plow");
    ctx.assertInvocationCurrent();
    if (args.action === "create") {
      if (!args.goal || !args.completion) throw new Error("A task needs a goal and completion condition");
      const intent = threadIdempotencyKey(callId, [ctx.sessionKey, args.goal, args.completion]);
      const existing = (await flows.list()).find(flow => flow.controllerId === "plow" && flow.stateJson && typeof flow.stateJson === "object" && !Array.isArray(flow.stateJson) && flow.stateJson.intent === intent);
      if (existing) return existing;
      ctx.assertInvocationCurrent();
      return await flows.createManaged({ controllerId: "plow", goal: args.goal, status: "queued", notifyPolicy: "silent", stateJson: { intent, completion: args.completion, deadline: args.deadline ?? null, authorizedBy: ctx.requesterSenderId!, conversation: conversationUid(ctx)!, destination: ctx.deliveryContext?.to ?? conversationUid(ctx)! } });
    }
    const flow = args.id ? await flows.get(args.id) : undefined;
    if (!flow || flow.controllerId !== "plow") throw new Error("Choose a task from this conversation's list");
    const mutation = { flowId: flow.flowId, expectedRevision: flow.revision };
    ctx.assertInvocationCurrent();
    if (args.action === "cancel") return await api.runtime.tasks.managedFlows.fromToolContext(ctx).cancel({ flowId: flow.flowId, cfg: ctx.config! });
    if (args.action === "wait") return await flows.setWaiting({ ...mutation, currentStep: args.step, waitJson: { question: args.step ?? "Awaiting input" } });
    if (args.action === "resume") return await flows.resume({ ...mutation, status: "running", currentStep: args.step });
    if (!args.evidence) throw new Error("Record the observed outcome and evidence");
    if (args.action === "finish" && (args.delivery === "unknown" || args.delivery === "failed")) throw new Error("Unconfirmed delivery cannot count as completed");
    const previous = flow.stateJson && typeof flow.stateJson === "object" && !Array.isArray(flow.stateJson) ? flow.stateJson : {};
    const stateJson = { ...previous, evidence: args.evidence, delivery: args.delivery ?? null };
    return args.action === "finish" ? await flows.finish({ ...mutation, stateJson }) : await flows.fail({ ...mutation, stateJson, blockedSummary: args.evidence });
  });
  tool("plow_notifications", "Inspect or persist pause/resume for scheduled phone work in this conversation; scope=all is owner-main-DM only. Pause disables existing jobs and blocks new ones; resume re-enables only unchanged jobs disabled by this control. Direct replies still work.", notifyArgs, async (ctx, args) => {
    const account = accountFor(ctx);
    if (account.accountId !== "chat") throw new Error("Notification controls require a phone conversation");
    const scope = args.scope === "all" ? await privateScope(account, ctx) : await activeScope(account, ctx, "plow_notifications", args.action !== "get");
    return await notificationControl(scheduler, scope, ctx, args.action, args.scope === "all", async job => {
      const sessionKey = job.owner?.sessionKey ?? job.sessionKey;
      if (!sessionKey) return;
      const binding = { sessionKey, agentId: ctx.agentId };
      const runs = await api.runtime.tasks.async.runs.bindSession(binding).list();
      for (const run of runs) if (run.sourceId === job.id || run.sourceId === `cron:${job.id}`) {
        if (!["queued", "running", "waiting", "blocked"].includes(run.status)) continue;
        ctx.assertInvocationCurrent();
        const result = await api.runtime.tasks.runs.bindSession(binding).cancel({ taskId: run.id, cfg: ctx.config! });
        if (!result.cancelled) throw new Error("The job is disabled but its active run could not be cancelled; check task status before confirming a complete stop");
      }
    });
  });
  api.on("before_tool_call", async (event, ctx) => {
    if (ctx.agentId === "plow-worker" && !["web_search", "web_fetch"].includes(event.toolName)) return { block: true, blockReason: "Background workers perform read-only research and analysis; the conversational agent owns messages, memory, scheduling and mutations" };
    if (event.toolName === "sessions_spawn" && (event.params?.agentId !== "plow-worker" || (event.params?.runtime && event.params.runtime !== "subagent"))) return { block: true, blockReason: "Delegate bounded research/analysis to agentId=plow-worker using the native subagent runtime" };
    const cronId = ctx.sessionKey?.match(/^agent:[^:]+:cron:([^:]+)/)?.[1];
    if (cronId && ["message", "plow_reply_to", "plow_send_email", "plow_start_thread"].includes(event.toolName)
      && !(event.toolName === "plow_send_email" && event.params?.action === "list")) {
      try {
        const configured = api.config?.channels?.plow as Account | undefined;
        if (!configured) throw new Error("Plow configuration unavailable");
        const account = { ...configured, accountId: "chat" };
        if (await notificationPaused(account, undefined, cronId)) return { block: true, blockReason: "Scheduled notifications are paused in their source, destination or global scope" };
      } catch { return { block: true, blockReason: "Scheduled notification state cannot be verified; inspect the scheduler before retrying" }; }
    }
    if (event.toolName !== "automations" || event.params?.action !== "add") return;
    const account = api.config?.channels?.plow as Account | undefined;
    if (!account) return { block: true, blockReason: "Plow configuration is unavailable" };
    if ((await readExperience({ account, conversation: "owner" })).paused) return { block: true, blockReason: "Scheduled notifications are paused; use plow_notifications to resume first" };
    const uid = ctx.sessionKey === "agent:main:main" ? (await ownerChat({ ...account, accountId: "chat" })).uid : ctx.sessionKey?.split(":").at(-1);
    if (uid?.startsWith("cht_") && (await readExperience({ account, conversation: uid })).paused) return { block: true, blockReason: "This room's scheduled notifications are paused" };
  });
}
