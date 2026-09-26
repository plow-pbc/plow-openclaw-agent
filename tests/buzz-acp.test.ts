import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { acpEnv, superviseAcp } from "../plugin/buzz-acp.ts";
import { OWNER, tagFor } from "./buzz-fixture.ts";

const key = { sk: "1".repeat(64), pk: "2".repeat(64) };
const tag = tagFor(0);

test("buzz-acp gets the key, tag and relay in its environment and drives openclaw acp against the local gateway", () => {
  const env = acpEnv({ relayUrl: "https://community.buzz.test/", key, tag, gatewayPort: 3000, passwordFile: "/state/gateway-password", respondTo: [] });
  assert.equal(env.BUZZ_PRIVATE_KEY, key.sk);
  assert.equal(env.BUZZ_AUTH_TAG, JSON.stringify(tag));
  assert.equal(env.BUZZ_RELAY_URL, "wss://community.buzz.test");
  assert.equal(env.BUZZ_ACP_AGENT_COMMAND, process.execPath);
  assert.equal(env.BUZZ_ACP_AGENT_ARGS, "/app/openclaw.mjs,acp,--url,ws://127.0.0.1:3000,--password-file,/state/gateway-password");
  assert.equal(env.BUZZ_ACP_RESPOND_TO, "owner-only");
  assert.ok(!("BUZZ_ACP_RESPOND_TO_ALLOWLIST" in env));
  assert.ok(!env.BUZZ_ACP_AGENT_ARGS.includes(key.sk));
});

test("a respond-to list switches buzz-acp to its allowlist gate", () => {
  const env = acpEnv({ relayUrl: "http://localhost:3000", key, tag, gatewayPort: 1, passwordFile: "/p", respondTo: [OWNER.toUpperCase()] });
  assert.equal(env.BUZZ_RELAY_URL, "ws://localhost:3000");
  assert.equal(env.BUZZ_ACP_RESPOND_TO, "allowlist");
  assert.equal(env.BUZZ_ACP_RESPOND_TO_ALLOWLIST, OWNER);
});

/** A stand-in for buzz-acp: appends its BUZZ_AUTH_TAG and whether it saw PLOW_AGENT_TOKEN, then stays up or exits. */
const fake = (file: string, stay: boolean) => ({
  command: process.execPath,
  args: ["-e", `require("fs").appendFileSync(${JSON.stringify(file)}, process.env.BUZZ_AUTH_TAG + ("PLOW_AGENT_TOKEN" in process.env ? " leaked" : "") + "\\n"); ${stay ? "setInterval(() => {}, 1000)" : "process.exit(3)"}`],
});
const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("timed out");
};
const lines = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);

test("the supervisor restarts buzz-acp when it exits, backing off, without the gateway's credentials", async t => {
  const dir = await mkdtemp(`${tmpdir()}/buzz-acp-`);
  t.after(() => rm(dir, { recursive: true }));
  process.env.PLOW_AGENT_TOKEN = "gateway-secret";
  const controller = new AbortController();
  const logs: string[] = [];
  const s = superviseAcp({ ...fake(`${dir}/runs`, false), env: { BUZZ_AUTH_TAG: "t1" }, signal: controller.signal, log: l => logs.push(l), backoffMs: 20 });
  await until(async () => (await lines(`${dir}/runs`)).length >= 3);
  controller.abort();
  await s.done;
  assert.ok(logs.some(l => /exited code=3/.test(l)));
  assert.ok((await lines(`${dir}/runs`)).every(l => l === "t1"));
});

test("a new attestation replaces the running buzz-acp, and abort stops it", async t => {
  const dir = await mkdtemp(`${tmpdir()}/buzz-acp-`);
  t.after(() => rm(dir, { recursive: true }));
  const controller = new AbortController();
  const s = superviseAcp({ ...fake(`${dir}/runs`, true), env: { BUZZ_AUTH_TAG: "t1" }, signal: controller.signal, log: () => {}, backoffMs: 20 });
  await until(async () => (await lines(`${dir}/runs`)).length === 1);
  s.restart({ BUZZ_AUTH_TAG: "t2" });
  await until(async () => (await lines(`${dir}/runs`)).length === 2);
  assert.deepEqual(await lines(`${dir}/runs`), ["t1", "t2"]);
  controller.abort();
  await s.done;
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await lines(`${dir}/runs`)).length, 2, "nothing restarts after abort");
});
