import { z } from "zod";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { accepts, request, normalizedHandle, ownerChat, type Account, type Chat } from "./transport.ts";
import { conversationUid, ownerDmTurn } from "./threads.ts";
import { preferencesSchema, roomSchema, readExperience, updateExperience, randomUUID, scopePath, type Scope } from "./experience-state.ts";

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
const roomArgs = z.object({ action: z.enum(["get", "set", "reset"]), settings: roomSchema.optional() }).strict();
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
}
