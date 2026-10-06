import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDefinition, agentDefinitionSchema, agentExtensions, assertImageInstallation } from "../boot/extensions.ts";
import { renderConfig, syncConfig } from "../boot/config.ts";

const extension = { id: "example", path: "/opt/example", tools: ["example_schedule"], conversationAccess: true };
const identity = { agent: { name: "Example" }, line: { uid: "line" }, chats: [] };

test("image extensions load on fresh installations while owner model and disablement survive syncing", async t => {
  const root = await mkdtemp(join(tmpdir(), "plow-extensions-")); t.after(() => rm(root, { recursive: true }));
  const file = join(root, "agent.json");
  assert.deepEqual(await agentExtensions(file), []);
  await writeFile(file, JSON.stringify([extension]));
  const installed = renderConfig(identity, "http://fixture", undefined, await agentExtensions(file));
  assert.ok(installed.plugins.load.paths.includes("/opt/example"));
  assert.deepEqual(installed.plugins.entries.example, { enabled: true, hooks: { allowConversationAccess: true } });
  assert.ok(installed.tools.alsoAllow.includes("example_schedule"));
  const config = join(root, "openclaw.json");
  await syncConfig(installed, config, join(root, "includes"));
  const original = JSON.parse(await readFile(config, "utf8"));
  original.plugins.entries.example.enabled = false;
  original.agents.defaults.model = { primary: "openai/gpt-6-luna" };
  await writeFile(config, JSON.stringify(original));
  await syncConfig(installed, config, join(root, "includes"));
  const synced = JSON.parse(await readFile(config, "utf8"));
  assert.equal(synced.plugins.entries.example.enabled, false);
  assert.equal(synced.agents.defaults.model.primary, "openai/gpt-6-luna");
});
for (const bad of [null, {}, [extension, extension], [{ ...extension, id: "plow" }], [{ ...extension, path: "/opt/../var/lib/plow" }], [{ ...extension, tools: [42] }], [{ ...extension, conversationAccess: "yes" }]]) test("malformed or unsafe image extensions fail closed: " + JSON.stringify(bad), async t => {
  const root = await mkdtemp(join(tmpdir(), "plow-extension-bad-")); t.after(() => rm(root, { recursive: true }));
  const file = join(root, "agent.json"); await writeFile(file, JSON.stringify(bad));
  await assert.rejects(agentExtensions(file));
});

test("image preflight rejects writable nested code and undeclared tools", async t => {
  const root = await mkdtemp("/opt/plow-preflight-"); t.after(() => rm(root, { recursive: true }));
  const plugin = { ...extension, path: root };
  const definition = agentDefinitionSchema.parse({ version: 1, plugins: [plugin] });
  await writeFile(join(root, "openclaw.plugin.json"), JSON.stringify({ id: plugin.id, contracts: { tools: plugin.tools } }));
  await mkdir(join(root, "nested")); await writeFile(join(root, "nested", "code.js"), "export default {};");
  await assertImageInstallation(definition);
  await chmod(join(root, "nested", "code.js"), 0o666);
  await assert.rejects(assertImageInstallation(definition), /immutable/);
  await chmod(join(root, "nested", "code.js"), 0o644);
  await writeFile(join(root, "openclaw.plugin.json"), JSON.stringify({ id: plugin.id, contracts: { tools: [] } }));
  await assert.rejects(assertImageInstallation(definition), /does not declare/);
});

test("image preflight rejects writable parents of installed paths and symlink targets", async t => {
  const root = await mkdtemp("/opt/plow-parent-preflight-"); t.after(() => rm(root, { recursive: true }));
  const parent = join(root, "replaceable"), skills = join(parent, "skills"), safe = join(root, "safe");
  await mkdir(skills, { recursive: true }); await mkdir(safe);
  await writeFile(join(parent, "code.md"), "Image-owned skill");
  await symlink(join(parent, "code.md"), join(safe, "linked.md"));
  const direct = agentDefinitionSchema.parse({ version: 1, skills: [skills] });
  const linked = agentDefinitionSchema.parse({ version: 1, skills: [safe] });
  await assertImageInstallation(direct); await assertImageInstallation(linked);
  await chmod(parent, 0o777);
  await assert.rejects(assertImageInstallation(direct), /parent.*immutable/);
  await assert.rejects(assertImageInstallation(linked), /parent.*immutable/);
  await chmod(parent, 0o755);
  await assertImageInstallation(direct); await assertImageInstallation(linked);
});

test("image manifests cannot be replaced through a writable parent", async t => {
  const root = await mkdtemp("/opt/plow-manifest-preflight-"); t.after(() => rm(root, { recursive: true }));
  const file = join(root, "agent.json"); await writeFile(file, JSON.stringify({ version: 1 }));
  assert.equal((await agentDefinition(file)).version, 1);
  await chmod(root, 0o777);
  await assert.rejects(agentDefinition(file), /parent.*immutable/);
  await chmod(root, 0o700);
  assert.equal((await agentDefinition(file)).version, 1);
});
