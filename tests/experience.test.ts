import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { installExperienceTools, notificationControl } from "../plugin/experience.ts";
import { experienceContext, quietNow, readExperience, scopePath, updateExperience } from "../plugin/experience-state.ts";
import { agentDefinition, agentDefinitionSchema } from "../boot/extensions.ts";
import { composePrompt, renderPrompt } from "../boot/prompt.ts";
import { renderConfig, syncConfig } from "../boot/config.ts";
import { healthy } from "../boot/health.ts";
import { personalityAxes, personalitySchema, personalityPatchSchema } from "../boot/personality.ts";
import { scheduler } from "../plugin/scheduler.ts";

const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "ln_fixture", guestTools: ["plow_memory", "plow_tasks"] };
const owner = { type: "member", uid: "owner", role: "owner", provider_key: "+15550000001" };
const guest = { type: "member", uid: "guest", role: "member", provider_key: "+15550000002" };
const self = { type: "agent", relationship: "self", line: { uid: account.lineUid } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [owner, self] };
const room = { uid: "cht_room", status: "active", trusted: false, participants: [owner, guest, self] };
async function fixture(t: any, runtime: any = {}) {
  const root = await mkdtemp(join(tmpdir(), "plow-experience-"));
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.OPENCLAW_CONFIG_PATH = join(root, "openclaw.json");
  process.env.PLOW_AGENT_TOKEN = "fixture";
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url.includes("cht_home") ? home : room));
  const factories = new Map<string, any>();
  installExperienceTools({ config: { channels: { plow: account } }, runtime, on() {}, registerTool(factory: any) {
    const context = { assertInvocationCurrent() {} };
    factories.set(factory.create(context).name, factory);
  } } as any, () => account);
  function tool(name: string, privateDm = false, overrides: object = {}) {
    return factories.get(name).create({ config: { channels: { plow: account } }, messageChannel: "plow", agentAccountId: "chat", agentId: "main",
      sessionKey: privateDm ? "agent:main:main" : "agent:main:plow:chat:group:cht_room", nativeChannelId: privateDm ? "cht_home" : "cht_room",
      requesterSenderId: privateDm ? "plow-owner" : guest.provider_key, senderIsOwner: privateDm,
      deliveryContext: { channel: "plow", accountId: "chat", to: privateDm ? "cht_home" : "cht_room" }, assertInvocationCurrent() {}, ...overrides });
  }
  return { root, tool };
}

test("personality schemas derive every axis from the registry and reject unknown or invalid values", () => {
  const neutral = personalitySchema.parse({});
  assert.deepEqual(Object.keys(neutral), personalityAxes.map(axis => axis.id));
  assert.ok(Object.values(neutral).every(value => value === 50));
  for (const axis of personalityAxes) {
    for (const value of [0, 50, 100]) assert.deepEqual(personalityPatchSchema.parse({ [axis.id]: value }), { [axis.id]: value });
    for (const value of [-1, 101, 1.5, "50", null]) assert.equal(personalityPatchSchema.safeParse({ [axis.id]: value }).success, false);
  }
  assert.equal(personalityPatchSchema.safeParse({ permission: 100 }).success, false);
  assert.equal(personalitySchema.safeParse({ permission: 100 }).success, false);
});

test("private preferences survive reopen and never enter a group's context", async t => {
  const { tool } = await fixture(t);
  await tool("plow_preferences", true).execute("one", { action: "set", preferences: { name: "Sam", timezone: "America/Sao_Paulo", voice: "Very direct", verbosity: "brief" } });
  assert.equal((await tool("plow_preferences", true).execute("two", { action: "get" })).details.name, "Sam");
  await assert.rejects(tool("plow_preferences").execute("three", { action: "get" }), /owner's main/);
  const group = await experienceContext(account, room.uid, false);
  assert.ok(!("owner_preferences" in group));
  assert.doesNotMatch(JSON.stringify(group), /Sam|Very direct/);
  assert.equal((await experienceContext(account, home.uid, true)).owner_preferences?.name, "Sam");
  await tool("plow_preferences", true).execute("reset", { action: "reset" });
  assert.deepEqual((await tool("plow_preferences", true).execute("get", { action: "get" })).details, {});
  await assert.rejects(tool("plow_preferences", true).execute("bad", { action: "set", preferences: { timezone: "MadeUp/Mars" } }));
});

test("public personality sliders preview without saving, preserve partial edits and survive reset without changing grants", async t => {
  const { tool } = await fixture(t);
  const personality = tool("plow_personality", true);
  const preview = (await personality.execute("preview", { action: "preview", sliders: { "execute-collaborate": 0, "polite-unfiltered": 100 } })).details;
  assert.equal(preview.saved, false); assert.match(preview.preview, /already authorized/);
  assert.equal((await readExperience({ account, conversation: "agent" })).personality, undefined);
  await personality.execute("save", { action: "set", sliders: { "execute-collaborate": 0, "polite-unfiltered": 100 } });
  await personality.execute("change", { action: "set", sliders: { "playful-serious": 100 } });
  const state = (await personality.execute("get", { action: "get" })).details;
  assert.equal(state.sliders["execute-collaborate"], 0); assert.equal(state.sliders["playful-serious"], 100);
  assert.match((await experienceContext(account, room.uid, false)).personality!.guidance, /Base routing, privacy, permissions/);
  await assert.rejects(tool("plow_personality").execute("guest", { action: "set", sliders: { "polite-unfiltered": 100 } }), /owner's main/);
  await assert.rejects(personality.execute("bad", { action: "set", sliders: { "polite-unfiltered": 101 } }));
  assert.equal(room.trusted, false);
  await personality.execute("reset", { action: "reset" });
  assert.equal((await experienceContext(account, room.uid, false)).personality, undefined);
});

test("scoped memory records provenance, supports correction/export/expiry/forget, and rejects another room's id", async t => {
  const { tool } = await fixture(t);
  const memory = tool("plow_memory");
  const saved = (await memory.execute("one", { action: "remember", text: "Thursday after 6", confirmed: true, expectedRevision: 0 })).details.notes[0];
  assert.equal(saved.source, guest.provider_key);
  assert.ok(Date.parse(saved.createdAt));
  await memory.execute("two", { action: "correct", id: saved.id, text: "Friday after 6", expectedRevision: 1 });
  assert.equal((await memory.execute("three", { action: "export" })).details.notes[0].text, "Friday after 6");
  await assert.rejects(memory.execute("private", { action: "get", scope: "owner" }), /owner's main/);
  await assert.rejects(tool("plow_memory", false, { nativeChannelId: "cht_other" }).execute("other", { action: "forget", id: saved.id, expectedRevision: 0 }), /existing memory id/);
  await memory.execute("expire", { action: "remember", text: "Old tentative note", confirmed: false, expiresAt: "2020-01-01T00:00:00Z", expectedRevision: 2 });
  assert.equal((await memory.execute("get", { action: "get" })).details.notes.length, 1);
  await memory.execute("forget", { action: "forget", id: saved.id, expectedRevision: 3 });
  await assert.rejects(memory.execute("stale", { action: "remember", text: "Thursday after 6", expectedRevision: 0 }), /Memory changed/);
  assert.equal((await memory.execute("revision", { action: "get" })).details.revision, 4);
  assert.deepEqual((await memory.execute("get", { action: "get" })).details.notes, []);
});

test("room purpose and mode require a current grant and do not change trust", async t => {
  const { tool } = await fixture(t);
  await assert.rejects(tool("plow_room").execute("guest", { action: "set", settings: { mode: "coordinator" } }), /not granted/);
  const ownerTool = tool("plow_room", false, { senderIsOwner: true, requesterSenderId: "plow-owner" });
  await ownerTool.execute("owner", { action: "set", settings: { mode: "coordinator", purpose: "Find a dinner time" } });
  assert.deepEqual((await tool("plow_room").execute("get", { action: "get" })).details, { mode: "coordinator", purpose: "Find a dinner time" });
  assert.equal(room.trusted, false);
  await assert.rejects(ownerTool.execute("bad", { action: "set", settings: { trusted: true } }));
  await assert.rejects(tool("plow_memory", false, { requesterSenderId: "+15559999999" }).execute("revoked", { action: "remember", text: "x" }), /no longer a member/);
});

test("refreshed membership preserves email punctuation and rejects a revoked colliding identity", async t => {
  const { tool } = await fixture(t);
  const remaining = { ...guest, provider_key: "annmarie@example.com" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...room, participants: [owner, remaining, self] }));
  const scope = { account, conversation: room.uid };
  await updateExperience(scope, () => {}, state => { state.notes.push({ id: "saved", text: "Keep this fact", source: remaining.provider_key, confirmed: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
  await assert.rejects(tool("plow_memory", false, { requesterSenderId: "ann-marie@example.com" }).execute("revoked", { action: "reset", expectedRevision: 0 }), /no longer a member/);
  const result = await tool("plow_memory", false, { requesterSenderId: remaining.provider_key }).execute("remaining", { action: "get" });
  assert.equal(result.details.notes[0].text, "Keep this fact");
  assert.equal(result.details.revision, 0);
});

test("identical room facts retain each member's provenance while deduplicating that member's own repeat", async t => {
  const { tool } = await fixture(t);
  const other = { ...guest, uid: "other", provider_key: "+15550000003" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...room, participants: [owner, guest, other, self] }));
  const first = tool("plow_memory"), second = tool("plow_memory", false, { requesterSenderId: other.provider_key });
  await first.execute("one", { action: "remember", text: "Thursday after 6", expectedRevision: 0 });
  const result = await second.execute("two", { action: "remember", text: "Thursday after 6", expectedRevision: 1 });
  assert.deepEqual(result.details.notes.map((note: { source: string }) => note.source), [guest.provider_key, other.provider_key]);
  const repeated = await first.execute("three", { action: "remember", text: "Thursday after 6", expectedRevision: 2 });
  assert.equal(repeated.details.notes.length, 2);
});

test("atomic scoped writes retain concurrent updates, protect the file and fence revoked effects", async t => {
  const { root } = await fixture(t);
  const scope = { account, conversation: room.uid };
  await Promise.all(Array.from({ length: 20 }, (_, i) => updateExperience(scope, () => {}, state => { state.notes.push({ id: String(i), text: String(i), source: "fixture", confirmed: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); })));
  assert.equal((await readExperience(scope)).notes.length, 20);
  assert.equal((await stat(scopePath(scope))).mode & 0o777, 0o600);
  let guards = 0;
  await assert.rejects(updateExperience(scope, () => { if (++guards === 2) throw new Error("revoked"); }, state => { state.room.purpose = "must not persist"; }), /revoked/);
  assert.equal((await readExperience(scope)).room.purpose, undefined);
  assert.ok((await readdir(join(root, "experience"))).every(file => file.endsWith(".json")));
  await writeFile(scopePath(scope), "broken");
  await assert.rejects(readExperience(scope), /restore its backup/);
  assert.equal(await readFile(scopePath(scope), "utf8"), "broken");
});

test("pause persists before scheduler calls, pages jobs, and resume preserves edits", async t => {
  await fixture(t);
  const scope = { account, conversation: room.uid }, ctx = { sessionKey: "room-session", agentId: "main", assertInvocationCurrent() {} };
  const jobs = new Map([
    ["one", { id: "one", enabled: true, configRevision: "one-a", owner: { sessionKey: ctx.sessionKey, accountId: "chat" } }],
    ["two", { id: "two", enabled: true, configRevision: "two-a", owner: { sessionKey: ctx.sessionKey, accountId: "chat" } }],
    ["other", { id: "other", enabled: true, configRevision: "other-a", owner: { sessionKey: "another-room", accountId: "chat" } }],
  ]);
  const calls: string[] = [];
  let pausing = true;
  const gateway = { async request(method: string, params: any) {
    calls.push(method);
    if (method === "cron.list") {
      assert.equal((await readExperience(scope)).paused, pausing);
      return { jobs: [...jobs.values()].slice(params.offset, params.offset + 1), hasMore: params.offset < jobs.size - 1, nextOffset: params.offset + 1 };
    }
    const job = jobs.get(params.id)!;
    if (method === "cron.update") {
      assert.equal(params.expectedConfigRevision, job.configRevision);
      job.enabled = params.patch.enabled; job.configRevision += "-changed";
    }
    return job;
  } };
  assert.equal((await notificationControl(gateway, scope, ctx, "pause", false)).paused, true);
  assert.deepEqual([...jobs.values()].map(job => job.enabled), [false, false, true]);
  jobs.get("two")!.configRevision = "owner-edited";
  pausing = false;
  await notificationControl(gateway, scope, ctx, "resume", false);
  assert.deepEqual([...jobs.values()].map(job => job.enabled), [true, false, true]);
  assert.equal((await readExperience(scope)).paused, false);
  assert.ok(calls.filter(call => call === "cron.list").length >= 3);
  await assert.rejects(notificationControl({ request: async () => { throw new Error("gateway offline"); } }, scope, ctx, "pause", false), /offline/);
  assert.equal((await readExperience(scope)).paused, true);
});

for (const fault of ["before-apply", "after-apply", "before-record"] as const) for (const retryPause of [false, true]) test(`pause journal survives ${fault}; retry pause=${retryPause}`, async t => {
  await fixture(t);
  const scope = { account, conversation: room.uid };
  let currentInvocation = true, interrupted = false, updates = 0;
  const ctx = { sessionKey: "room-session", agentId: "main", assertInvocationCurrent() { if (!currentInvocation) throw new Error("invocation revoked"); } };
  const job = { id: "job", enabled: true, configRevision: "original", owner: { sessionKey: ctx.sessionKey, accountId: "chat" },
    schedule: { kind: "every", everyMs: 60_000 }, state: { lastRunAtMs: 0 }, updatedAtMs: 0 };
  const gateway = { async request(method: string, params: any) {
    if (method === "cron.list") return { jobs: [structuredClone(job)], hasMore: false };
    if (method === "cron.update") {
      assert.equal((await readExperience(scope)).paused, !params.patch.enabled);
      assert.equal(params.expectedConfigRevision, job.configRevision);
      if (!interrupted) {
        interrupted = true;
        if (fault === "before-apply") throw new Error("response lost");
        job.enabled = false; job.configRevision = "disabled"; updates++;
        if (fault === "after-apply") throw new Error("response lost");
        currentInvocation = false;
      } else { job.enabled = params.patch.enabled; job.configRevision = job.enabled ? "enabled" : "disabled"; updates++; }
    }
    return structuredClone(job);
  } };
  await assert.rejects(notificationControl(gateway, scope, ctx, "pause", false), /response lost|invocation revoked/);
  const journal = await readExperience(scope);
  assert.equal(journal.paused, true);
  assert.equal(journal.suspendedJobs[0].id, job.id);
  assert.ok(journal.suspendedJobs[0].pendingDefinition, "the intent must survive before an external mutation");
  currentInvocation = true;
  // Scheduler runtime activity must not be mistaken for an owner's definition edit.
  job.state.lastRunAtMs = Date.now(); job.updatedAtMs = Date.now();
  if (retryPause) await notificationControl(gateway, scope, ctx, "pause", false);
  await notificationControl(gateway, scope, ctx, "resume", false);
  assert.equal(job.enabled, true);
  assert.equal((await readExperience(scope)).paused, false);
  assert.deepEqual((await readExperience(scope)).suspendedJobs, []);
  assert.equal(updates, fault === "before-apply" && !retryPause ? 0 : 2, "a confirmed disable is not sent twice");
});

test("a lost disable response preserves subsequent owner definition edits and pre-disabled jobs", async t => {
  await fixture(t);
  const scope = { account, conversation: room.uid }, ctx = { sessionKey: "room-session", agentId: "main", assertInvocationCurrent() {} };
  const jobs = [
    { id: "job", enabled: true, configRevision: "original", owner: { sessionKey: ctx.sessionKey, accountId: "chat" }, extensionSetting: { instruction: "original" } },
    { id: "owner-disabled", enabled: false, configRevision: "manual", owner: { sessionKey: ctx.sessionKey, accountId: "chat" }, extensionSetting: {} },
  ];
  let updates = 0;
  const gateway = { async request(method: string, params: any) {
    if (method === "cron.list") return { jobs: structuredClone(jobs), hasMore: false };
    const job = jobs.find(job => job.id === params.id)!;
    if (method === "cron.update") { updates++; job.enabled = params.patch.enabled; job.configRevision = "disabled"; throw new Error("response lost"); }
    return structuredClone(job);
  } };
  await assert.rejects(notificationControl(gateway, scope, ctx, "pause", false), /response lost/);
  jobs[0].extensionSetting.instruction = "owner edited"; jobs[0].configRevision = "owner-edit";
  await notificationControl(gateway, scope, ctx, "resume", false);
  assert.deepEqual(jobs.map(job => job.enabled), [false, false]);
  assert.equal(updates, 1);
  assert.equal((await readExperience(scope)).paused, false);
});

test("a job moved to another conversation between list and get cannot be disabled", async t => {
  await fixture(t);
  const scope = { account, conversation: room.uid }, ctx = { sessionKey: "room-session", agentId: "main", assertInvocationCurrent() {} };
  const job = { id: "job", enabled: true, configRevision: "original", owner: { sessionKey: ctx.sessionKey, accountId: "chat" } };
  let updates = 0;
  const gateway = { async request(method: string) {
    if (method === "cron.list") return { jobs: [structuredClone(job)], hasMore: false };
    if (method === "cron.update") updates++;
    return { ...job, configRevision: "owner-edited", owner: { ...job.owner, sessionKey: "other-room" } };
  } };
  await notificationControl(gateway, scope, ctx, "pause", false);
  assert.equal(updates, 0);
  assert.deepEqual((await readExperience(scope)).suspendedJobs, []);
});

test("a lost resume response opens the requested gate before enabling and retains its journal for retry", async t => {
  await fixture(t);
  const scope = { account, conversation: room.uid }, ctx = { sessionKey: "room-session", agentId: "main", assertInvocationCurrent() {} };
  const job = { id: "job", enabled: true, configRevision: "original", owner: { sessionKey: ctx.sessionKey, accountId: "chat" } };
  let failResume = true, updates = 0;
  const gateway = { async request(method: string, params: any) {
    if (method === "cron.list") return { jobs: [structuredClone(job)], hasMore: false };
    if (method === "cron.update") {
      assert.equal(params.expectedConfigRevision, job.configRevision);
      job.enabled = params.patch.enabled; job.configRevision = job.enabled ? "enabled" : "disabled"; updates++;
      if (job.enabled) assert.equal((await readExperience(scope)).paused, false, "the enabled job must be allowed to deliver even if its response is lost");
      if (job.enabled && failResume) { failResume = false; throw new Error("resume response lost"); }
    }
    return structuredClone(job);
  } };
  await notificationControl(gateway, scope, ctx, "pause", false);
  await assert.rejects(notificationControl(gateway, scope, ctx, "resume", false), /resume response lost/);
  assert.equal((await readExperience(scope)).paused, false);
  await notificationControl(gateway, scope, ctx, "resume", false);
  assert.equal((await readExperience(scope)).paused, false);
  assert.equal(updates, 2);
});

test("quiet hours handle midnight and timezone transitions without muting timed reminders", async t => {
  await fixture(t);
  const scope = { account, conversation: "owner" };
  const state = await updateExperience(scope, () => {}, value => { value.preferences.quietHours = { start: "22:00", end: "08:00", timezone: "America/New_York" }; });
  assert.equal(quietNow(state, new Date("2026-03-08T07:30:00Z")), true);
  assert.equal(quietNow(state, new Date("2026-03-08T16:00:00Z")), false);
});

test("paused scheduled tool sends are blocked while ordinary replies retain access", async t => {
  await fixture(t);
  let hook: any;
  installExperienceTools({ config: { channels: { plow: account } }, registerTool() {}, on(name: string, callback: unknown) { if (name === "before_tool_call") hook = callback; } } as any, () => account);
  t.mock.method(scheduler, "request", async () => ({ id: "job", enabled: true, sessionKey: "agent:main:plow:chat:group:cht_room", delivery: { channel: "plow", to: home.uid, accountId: "chat" } }));
  const context = { agentId: "main", sessionKey: "agent:main:cron:job:run:fixture" };
  assert.equal(await hook({ toolName: "message", params: {} }, context), undefined);
  await updateExperience({ account, conversation: room.uid }, () => {}, state => { state.paused = true; });
  assert.equal((await hook({ toolName: "message", params: {} }, context)).block, true);
  assert.equal(await hook({ toolName: "message", params: {} }, { ...context, sessionKey: "agent:main:main" }), undefined);
  t.mock.method(scheduler, "request", async () => { throw new Error("scheduler offline"); });
  assert.equal((await hook({ toolName: "message", params: {} }, context)).block, true);
});

test("globally paused phone rooms report the gate without exposing private owner state", async t => {
  await fixture(t);
  await updateExperience({ account, conversation: "owner" }, () => {}, state => {
    state.paused = true; state.preferences.name = "PRIVATE_PROFILE_CANARY";
  });
  const context = await experienceContext(account, room.uid, false);
  assert.equal(context.notifications_paused, true);
  assert.ok(!("owner_preferences" in context));
  assert.ok(!JSON.stringify(context).includes("PRIVATE_PROFILE_CANARY"));
  assert.equal((await experienceContext({ ...account, accountId: "email" }, room.uid, false)).notifications_paused, false);
});

test("manifest persona composition retains base policy and existing explicit defaults", async t => {
  const { root } = await fixture(t);
  const definition = agentDefinitionSchema.parse({ version: 1, persona: { role: "Tutor", purpose: "Teach clearly", voice: "Warm", examples: ["User: I am stuck. Agent: Let's try one step."] }, defaults: { groupMode: "helper" } });
  const prompt = composePrompt(await readFile(new URL("../prompt/BASE.md", import.meta.url), "utf8"), "legacy", definition);
  assert.match(prompt, /Tutor/); assert.match(prompt, /Base behavior governs/); assert.doesNotMatch(prompt, /legacy/);
  assert.ok((await renderPrompt(prompt, null, "fixture")).length < 20_000);
  const manifest = join(root, "agent.json"); await writeFile(manifest, JSON.stringify({ ...definition, version: 2 }));
  await assert.rejects(agentDefinition(manifest));
  const config = renderConfig({ agent: { name: "API name" }, line: { uid: "line" }, chats: [] }, account.apiBase);
  const path = join(root, "config.json"), includes = join(root, "includes");
  await writeFile(path, JSON.stringify({ agents: { defaults: { silentReply: { group: "disallow" } } } }));
  await syncConfig(config, path, includes);
  assert.equal(JSON.parse(await readFile(path, "utf8")).agents.defaults.silentReply.group, "disallow");
  await writeFile(path, JSON.stringify({ agents: { defaults: {} } })); await syncConfig(config, path, includes);
  assert.equal(JSON.parse(await readFile(path, "utf8")).agents.defaults.silentReply.group, "allow");
});

test("native task flows persist commitments across runtime recreation, isolate rooms and record terminal evidence", async t => {
  const require = createRequire(new URL("../plugin/package.json", import.meta.url));
  const dist = dirname(require.resolve("openclaw"));
  const file = (await readdir(dist)).find(file => /^runtime-[a-zA-Z0-9_-]+\.mjs$/.test(file) && file.startsWith("runtime-DkD"));
  assert.ok(file, "Pinned runtime's native task implementation must exist");
  const module = await import(pathToFileURL(join(dist, file)).href);
  const createRuntime: any = Object.values(module).find((fn: any) => typeof fn === "function" && fn.name === "createPluginRuntime");
  assert.ok(createRuntime);
  const runtime = createRuntime();
  const { root, tool } = await fixture(t, runtime);
  await writeFile(join(root, "openclaw.json"), JSON.stringify(renderConfig({ agent: { name: "Fixture" }, line: { uid: account.lineUid }, chats: [] }, account.apiBase)));
  const tasks = tool("plow_tasks");
  const created = (await tasks.execute("create", { action: "create", goal: "Dinner booking", completion: "Restaurant confirms a table", deadline: "2026-12-01T18:00:00Z" })).details;
  assert.equal(created.status, "queued");
  const secondRuntime = createRuntime();
  const records = await secondRuntime.tasks.async.managedFlows.bindSession({ sessionKey: "agent:main:plow:chat:group:cht_room" }).list();
  assert.ok(records.some((record: any) => record.flowId === created.flowId));
  assert.deepEqual((await tool("plow_tasks", false, { sessionKey: "agent:main:plow:chat:group:cht_other", nativeChannelId: "cht_other" }).execute("list", { action: "list" })).details, []);
  await tasks.execute("resume", { action: "resume", id: created.flowId, step: "Waiting for restaurant receipt" });
  await assert.rejects(tasks.execute("unknown", { action: "finish", id: created.flowId, evidence: "Request timed out", delivery: "unknown" }), /cannot count as completed/);
  const finished = (await tasks.execute("finish", { action: "finish", id: created.flowId, evidence: "Provider receipt fixture-1 confirms a table", delivery: "confirmed" })).details;
  assert.equal(finished.applied, true); assert.equal(finished.flow.status, "succeeded");
  assert.match(finished.flow.stateJson.evidence, /fixture-1/);
});
