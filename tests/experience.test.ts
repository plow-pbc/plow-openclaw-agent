import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { installExperienceTools } from "../plugin/experience.ts";
import { experienceContext, quietNow, readExperience, scopePath, updateExperience } from "../plugin/experience-state.ts";
import { agentDefinition, agentDefinitionSchema } from "../boot/extensions.ts";
import { composePrompt, renderPrompt } from "../boot/prompt.ts";
import { renderConfig, syncConfig } from "../boot/config.ts";
import { healthy } from "../boot/health.ts";

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

test("quiet hours handle midnight and timezone transitions without muting timed reminders", async t => {
  await fixture(t);
  const scope = { account, conversation: "owner" };
  const state = await updateExperience(scope, () => {}, value => { value.preferences.quietHours = { start: "22:00", end: "08:00", timezone: "America/New_York" }; });
  assert.equal(quietNow(state, new Date("2026-03-08T07:30:00Z")), true);
  assert.equal(quietNow(state, new Date("2026-03-08T16:00:00Z")), false);
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
