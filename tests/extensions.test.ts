import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDefinition, agentDefinitionSchema, assertImageInstallation } from "../boot/extensions.ts";
import { renderConfig, syncConfig } from "../boot/config.ts";

const extension = { id: "example", path: "/opt/example", tools: ["example_schedule"], conversationAccess: true };
const identity = { agent: { name: "Example" }, line: { uid: "line" }, chats: [] };

test("image extensions load on fresh installations while owner model and disablement survive syncing", async t => {
  const root = await mkdtemp(join(tmpdir(), "plow-extensions-")); t.after(() => rm(root, { recursive: true }));
  const file = join(root, "agent.json");
  assert.deepEqual((await agentDefinition(file)).plugins, []);
  await writeFile(file, JSON.stringify([extension]));
  const installed = renderConfig(identity, "http://fixture", await agentDefinition(file));
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
  await assert.rejects(agentDefinition(file));
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

test("image preflight rejects writable parents of installed paths", async t => {
  const root = await mkdtemp("/opt/plow-parent-preflight-"); t.after(() => rm(root, { recursive: true }));
  const parent = join(root, "replaceable"), skills = join(parent, "skills");
  await mkdir(skills, { recursive: true });
  const direct = agentDefinitionSchema.parse({ version: 1, skills: [skills] });
  await assertImageInstallation(direct);
  await chmod(parent, 0o777);
  await assert.rejects(assertImageInstallation(direct), /parents.*immutable/);
  await chmod(parent, 0o755);
  await assertImageInstallation(direct);
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

test("new image skills merge into existing volumes and preserve owner additions across repeated boots", async t => {
  const root = await mkdtemp(join(tmpdir(), "plow-skills-migrate-")); t.after(() => rm(root, { recursive: true }));
  const path = join(root, "openclaw.json"), includes = join(root, "includes");
  const old = renderConfig(identity, "http://fixture");
  old.skills.load.extraDirs.push("/var/lib/plow/owner-skills");
  await syncConfig(old, path, includes);
  const next = renderConfig(identity, "http://fixture", agentDefinitionSchema.parse({ version: 1, skills: ["/opt/example/skills"] }));
  for (let boot = 0; boot < 3; boot++) {
    await syncConfig(next, path, includes);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.skills.load.extraDirs, ["/opt/plow/skills", "/opt/example/skills", "/var/lib/plow/owner-skills"]);
  }
});

for (const link of ["directory", "ancestor", "nested-file", "manifest", "multi-hop"] as const) test(`image preflight rejects ${link} symlinks`, async t => {
  const root = await mkdtemp("/opt/plow-symlink-preflight-"), mutable = await mkdtemp(join(tmpdir(), "plow-mutable-link-"));
  t.after(() => rm(root, { recursive: true })); t.after(() => rm(mutable, { recursive: true }));
  const safe = join(root, "safe"), installed = join(root, "installed");
  await mkdir(safe); await writeFile(join(safe, "SKILL.md"), "An image skill");
  await writeFile(join(safe, "agent.json"), JSON.stringify({ version: 1 }));
  if (link === "nested-file") await symlink(join(safe, "SKILL.md"), join(safe, "linked.md"));
  else if (link === "manifest") await symlink(join(safe, "agent.json"), installed);
  else if (link === "multi-hop") {
    await chmod(mutable, 0o777);
    await symlink(safe, join(mutable, "link"));
    await symlink(join(mutable, "link"), installed);
  } else await symlink(safe, installed);
  if (link === "manifest") await assert.rejects(agentDefinition(installed), /symlinks/);
  else {
    if (link === "ancestor") await mkdir(join(safe, "skills"));
    const path = link === "nested-file" ? safe : link === "ancestor" ? join(installed, "skills") : installed;
    await assert.rejects(assertImageInstallation(agentDefinitionSchema.parse({ version: 1, skills: [path] })), /symlinks/);
  }
});
