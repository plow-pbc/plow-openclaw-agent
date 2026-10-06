import { createHash, randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "./transport.ts";
import { personalitySchema, personalityInstructions } from "../boot/personality.ts";

const timezone = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Use an IANA timezone");
export const preferencesSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), language: z.string().trim().min(1).max(100).optional(),
  timezone: timezone.optional(), voice: z.string().max(1000).optional(),
  verbosity: z.enum(["brief", "balanced", "detailed"]).optional(),
  initiative: z.enum(["requested", "suggest", "proactive"]).optional(),
  notificationMinIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  quietHours: z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone }).strict().optional(),
}).strict();
export const roomSchema = z.object({
  mode: z.enum(["helper", "coordinator", "facilitator"]).optional(),
  purpose: z.string().max(1000).optional(),
}).strict();
const note = z.object({
  id: z.string(), text: z.string().trim().min(1).max(1000), source: z.string().max(200),
  confirmed: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime().optional(),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), preferences: preferencesSchema.default({}), room: roomSchema.default({}),
  personality: personalitySchema.optional(),
  lastHeartbeatAt: z.string().datetime().optional(),
  notes: z.array(note).max(100).default([]), paused: z.boolean().default(false),
  notesRevision: z.number().int().nonnegative().default(0),
  suspendedJobs: z.array(z.object({ id: z.string(), revision: z.string() }).strict()).max(1000).default([]),
}).strict();
export type ExperienceState = z.infer<typeof stateSchema>;
export type Scope = { account: Account; conversation: string | "owner" };
const lockKey = Symbol.for("plow.experience.locks");
const shared = globalThis as typeof globalThis & { [lockKey]?: Map<string, Promise<void>> };
const locks = shared[lockKey] ??= new Map<string, Promise<void>>();

export function scopePath(scope: Scope): string {
  const id = createHash("sha256").update(JSON.stringify([scope.account.apiBase, scope.account.lineUid, scope.conversation])).digest("hex");
  return join(process.env.OPENCLAW_STATE_DIR ?? "/var/lib/plow", "experience", `${id}.json`);
}
export async function readExperience(scope: Scope): Promise<ExperienceState> {
  try {
    const state = stateSchema.parse(JSON.parse(await readFile(scopePath(scope), "utf8")));
    state.notes = state.notes.filter(value => !value.expiresAt || Date.parse(value.expiresAt) > Date.now());
    return state;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return stateSchema.parse({ version: 1 });
    throw new Error("Experience state is unreadable; restore its backup rather than resetting it", { cause: error });
  }
}
export async function updateExperience(scope: Scope, assertCurrent: () => void, update: (state: ExperienceState) => void | Promise<void>): Promise<ExperienceState> {
  const path = scopePath(scope);
  const previous = locks.get(path) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(async () => {
    const state = await readExperience(scope);
    assertCurrent();
    await update(state);
    const validated = stateSchema.parse(state);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(validated) + "\n", { mode: 0o600 });
      assertCurrent();
      renameSync(temporary, path);
      return validated;
    } finally { await rm(temporary, { force: true }); }
  });
  const settled = result.then(() => {}, () => {});
  locks.set(path, settled);
  void settled.then(() => { if (locks.get(path) === settled) locks.delete(path); });
  return result;
}
export async function experienceContext(account: Account, conversation: string, ownerDm: boolean) {
  const scope = { account, conversation: ownerDm ? "owner" : conversation };
  const state = await readExperience(scope);
  const room = ownerDm ? await readExperience({ account, conversation }) : state;
  const persona = (await readExperience({ account, conversation: "agent" })).personality;
  return { ...(ownerDm ? { owner_preferences: state.preferences } : {}), room: { mode: account.groupMode ?? "helper", ...room.room },
    ...(persona ? { personality: { sliders: persona, guidance: personalityInstructions(persona) } } : {}),
    memory: [...state.notes.map(note => ({ ...note, scope: ownerDm ? "owner" : "conversation" })), ...(ownerDm ? room.notes.map(note => ({ ...note, scope: "conversation" })) : [])].slice(-8), notifications_paused: state.paused || room.paused };
}
export function quietNow(state: ExperienceState, now = new Date()): boolean {
  const hours = state.preferences.quietHours;
  if (!hours) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: hours.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const time = `${parts.find(part => part.type === "hour")?.value}:${parts.find(part => part.type === "minute")?.value}`;
  return hours.start === hours.end || (hours.start < hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end);
}

export { randomUUID };
