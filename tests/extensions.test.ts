import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentExtensions } from "../boot/extensions.ts";
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
