import { z } from "zod";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { accepts, request, normalizedHandle, type Account, type Chat } from "./transport.ts";
import { conversationUid, ownerDmTurn } from "./threads.ts";
import { preferencesSchema, roomSchema, readExperience, updateExperience, randomUUID, type Scope } from "./experience-state.ts";
import { threadIdempotencyKey } from "./delivery-guard.ts";
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
  tool("plow_preferences", "Inspect, set or reset confirmed private preferences in the owner's main DM. Changes survive restart and do not change authority. Quiet hours are stored here; the notification layer enforces them for optional heartbeats.", preferenceArgs, async (ctx, args) => {
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
  api.on("before_tool_call", async (event, ctx) => {
    if (ctx.agentId === "plow-worker" && !["web_search", "web_fetch"].includes(event.toolName)) return { block: true, blockReason: "Background workers perform read-only research and analysis; the conversational agent owns messages, memory, scheduling and mutations" };
    if (event.toolName === "sessions_spawn" && (event.params?.agentId !== "plow-worker" || (event.params?.runtime && event.params.runtime !== "subagent"))) return { block: true, blockReason: "Delegate bounded research/analysis to agentId=plow-worker using the native subagent runtime" };
  });
}
