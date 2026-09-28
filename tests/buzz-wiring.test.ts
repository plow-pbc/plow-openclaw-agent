import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import entry from "../plugin/index.ts";
import { renderConfig, syncConfig, type Identity } from "../boot/config.ts";
import { OWNER } from "./buzz-fixture.ts";

const identity: Identity = { agent: { name: "juniper-image" }, line: { uid: "ln_phone" }, chats: [] };
const optIn = { BUZZ_ATTESTATION_PROVIDER: "https://provider.test", BUZZ_RESPOND_TO: `${OWNER.toUpperCase()}, `,
  AGENT_NAME: "Juniper Lee", AGENT_BLURB: "Plans your week", AGENT_AVATAR: "https://example.test/juniper.png" };
// Everything a Buzz variant sets except the opt-in itself.
const { BUZZ_ATTESTATION_PROVIDER: _, ...withoutOptIn } = optIn;

for (const [mode, channels] of [["full", ["buzz", "plow"]], ["discovery", ["buzz", "plow"]], ["tool-discovery", []], ["cli-metadata", []]] as const) test(`${mode} registers channels ${JSON.stringify(channels)}, plow last`, () => {
  const ids: string[] = [];
  entry.register({ registrationMode: mode, runtime: {}, logger: { info() {} }, on() {}, registerTool() {},
    registerChannel(value: { plugin: { id: string } }) { ids.push(value.plugin.id); } } as never);
  assert.deepEqual(ids, channels);
});

test("the manifest declares the buzz channel and its config", async () => {
  const manifest = JSON.parse(await readFile(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.channels, ["plow", "buzz"]);
  assert.deepEqual(manifest.channelConfigs.buzz.schema.required, ["provider", "respondTo", "name", "handle", "about"]);
});

test("without BUZZ_ATTESTATION_PROVIDER the rendered config is exactly the one without Buzz", () => {
  const config = renderConfig(identity, "http://api:8000", withoutOptIn);
  assert.deepEqual(config, renderConfig(identity, "http://api:8000"));
  assert.deepEqual(Object.keys(config.channels), ["plow"]);
  assert.deepEqual(config.tools.alsoAllow, ["read", "write", "edit", "exec", "plow_start_thread"]);
});

test("an image that names an attestation provider joins Buzz; Plow routing is unchanged", () => {
  const config = renderConfig(identity, "http://api:8000", optIn);
  assert.deepEqual(config.channels.buzz, {
    provider: "https://provider.test", respondTo: [OWNER], name: "Juniper Lee", handle: "juniper-lee",
    about: "Plans your week", avatar: "https://example.test/juniper.png",
  });
  const { buzz: _buzz, ...channels } = config.channels;
  const plain = renderConfig(identity, "http://api:8000");
  assert.deepEqual({ ...config, channels, tools: plain.tools }, plain);
  assert.deepEqual(config.tools.alsoAllow, [...plain.tools.alsoAllow, "buzz_enroll"]);
});

test("the Buzz name falls back to the Plow agent name, and the handle fits a provider's name rules", () => {
  const config = renderConfig({ ...identity, agent: { name: "  The Very Long Agent Name For A Plow Line!!  " } }, "http://api:8000", { BUZZ_ATTESTATION_PROVIDER: "https://provider.test" });
  assert.equal(config.channels.buzz?.name, "The Very Long Agent Name For A Plow Line!!");
  assert.equal(config.channels.buzz?.handle, "the-very-long-agent-name-for-a-p");
  assert.deepEqual(config.channels.buzz?.respondTo, []);
  assert.equal(config.channels.buzz?.about, "");
});

test("a malformed opt-in stops boot instead of breaking the gateway's config", () => {
  assert.throws(() => renderConfig(identity, "http://api:8000", { BUZZ_ATTESTATION_PROVIDER: "provider.test" }), /http\(s\) URL/);
  assert.throws(() => renderConfig(identity, "http://api:8000", { ...optIn, BUZZ_RESPOND_TO: "npub1xyz" }), /hex pubkeys/);
});

async function includes(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "plow-buzz-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { path: join(dir, "openclaw.json"), includes: join(dir, "includes") };
}

test("the buzz channel is a Plow-owned include that goes away when the image stops opting in", async t => {
  const plain = await includes(t);
  await syncConfig(renderConfig(identity, "http://api:8000"), plain.path, plain.includes);
  const f = await includes(t);
  await syncConfig(renderConfig(identity, "http://api:8000", withoutOptIn), f.path, f.includes);
  assert.deepEqual(await readdir(f.includes), await readdir(plain.includes));
  assert.equal(await readFile(f.path, "utf8"), (await readFile(plain.path, "utf8")).replaceAll(plain.includes, f.includes));

  await syncConfig(renderConfig(identity, "http://api:8000", optIn), f.path, f.includes);
  assert.deepEqual(JSON5.parse(await readFile(f.path, "utf8")).channels.buzz, { $include: join(f.includes, "buzz-channel.json5") });
  assert.equal(JSON5.parse(await readFile(join(f.includes, "buzz-channel.json5"), "utf8")).provider, "https://provider.test");

  await syncConfig(renderConfig(identity, "http://api:8000"), f.path, f.includes);
  assert.equal(JSON5.parse(await readFile(f.path, "utf8")).channels.buzz, undefined);
  assert.deepEqual(await readdir(f.includes), await readdir(plain.includes));
});

type Factory = (context: object) => { name: string; execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> } | null;
function enrollFactory() {
  let factory: Factory | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: Factory) { if (value({ config: renderConfig(identity, "http://api:8000", optIn) })?.name === "buzz_enroll") factory = value; } } as never);
  return factory!;
}

test("buzz_enroll exists only for an agent opted into Buzz", () => {
  const factory = enrollFactory();
  assert.equal(factory({}), null);
  assert.equal(factory({ config: renderConfig(identity, "http://api:8000") }), null);
});

test("buzz_enroll hands the model a fresh approval link", async t => {
  const root = await mkdtemp(`${tmpdir()}/buzz-enroll-`);
  t.after(() => rm(root, { recursive: true }));
  process.env.OPENCLAW_STATE_DIR = root;
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/v1/attest")) return Response.json({ error: "unknown_agent", message: "enroll first" }, { status: 403 });
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ url: "https://provider.test/enroll/abc", expires_at: Math.floor(Date.now() / 1000) + 900 });
  });
  const tool = enrollFactory()({ config: renderConfig(identity, "http://api:8000", optIn) })!;
  const r = await tool.execute("call", {});
  assert.equal(r.content[0]!.text, "Approve me into Buzz: https://provider.test/enroll/abc");
  assert.deepEqual(bodies, [{ name: "juniper-lee", harness: "openclaw", model: "plow/z-ai/glm-5.2" }]);
  assert.equal((await tool.execute("call", {})).content[0]!.text, "An approval link was already sent and has not expired yet.");
});
