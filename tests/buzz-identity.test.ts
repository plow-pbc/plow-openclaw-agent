import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { joinBuzz, loadOrCreateKey, readState, updateState } from "../plugin/buzz-identity.ts";
import { headersOf, tagFor, verifyNip98 } from "./buzz-fixture.ts";

async function stateDir(t: TestContext) {
  const root = await mkdtemp(`${tmpdir()}/buzz-identity-`);
  t.after(() => rm(root, { recursive: true }));
  return `${root}/buzz`;
}

test("the key is created once, private, and reused", async t => {
  const dir = await stateDir(t);
  const first = await loadOrCreateKey(dir);
  assert.match(first.sk, /^[0-9a-f]{64}$/);
  assert.equal((await stat(`${dir}/key`)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await loadOrCreateKey(dir), first);
});

/** An attestation provider answering from `answers`, recording NIP-98-verified calls. */
function provider(answers: Record<string, () => Response>) {
  const calls: { path: string; pubkey: string; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = String(init.body ?? "");
    const pubkey = verifyNip98(headersOf(init).Authorization, { method: "POST", url, body });
    const path = new URL(url).pathname;
    calls.push({ path, pubkey, body: JSON.parse(body) });
    return answers[path]!();
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}
const refuse = (error: string) => () => Response.json({ error, message: error }, { status: 403 });
const tag = tagFor(0);
const enroll = { name: "juniper", harness: "openclaw", model: "plow/z-ai/glm-5.2" };

/** `failTexts` is how many texts fail first, as when the owner has no chat yet. */
async function setup(t: TestContext, answers: Record<string, () => Response>, failTexts = 0) {
  const dir = await stateDir(t);
  const key = await loadOrCreateKey(dir);
  const p = provider(answers);
  const texts: string[] = [];
  let now = 1_000_000;
  const join = (force = false) => joinBuzz({
    dir, key, provider: "https://provider.test/", fetch: p.fetch, now: () => now, force, enroll,
    notifyOwner: async text => {
      if (failTexts > 0) { failTexts--; throw new Error("no chat with the owner yet"); }
      texts.push(text);
    },
  });
  return { dir, key, p, texts, join, advance: (s: number) => { now += s; } };
}

test("an enrolled agent attests and the tag is cached where the buzz CLI wrapper reads it", async t => {
  const s = await setup(t, { "/v1/attest": () => Response.json({ tag, expires_at: 2_000_000_000 }) });
  assert.deepEqual(await s.join(), { status: "attested", tag, expiresAt: 2_000_000_000 });
  assert.deepEqual(JSON.parse(await readFile(`${s.dir}/auth-tag`, "utf8")), tag);
  assert.equal((await stat(`${s.dir}/auth-tag`)).mode & 0o777, 0o600);
  assert.equal(s.p.calls[0]!.pubkey, s.key.pk);
  assert.deepEqual(s.texts, []);
});

test("an unknown agent enrolls with its claim and texts the owner the link, once", async t => {
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => Response.json({ url: "https://provider.test/enroll/abc", expires_at: 1_000_900 }),
  });
  assert.deepEqual(await s.join(), { status: "enrolling" });
  assert.deepEqual(s.p.calls[1]!.body, enroll);
  assert.deepEqual(s.texts, ["Approve me into Buzz: https://provider.test/enroll/abc"]);
  s.advance(3600);
  assert.deepEqual(await s.join(), { status: "enrolling" });
  assert.equal(s.texts.length, 1, "no second link within a day");
  assert.equal((await readState(s.dir)).enrollLink?.sentAt, 1_000_000);
});

test("a new link goes out after a day, or once the old one expired when the owner asks", async t => {
  let n = 0;
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => { n++; return Response.json({ url: `https://provider.test/enroll/${n}`, expires_at: 1_000_000 + n * 900 }); },
  });
  await s.join();
  s.advance(600);
  await s.join(true);
  assert.equal(s.texts.length, 1, "the first link has not expired yet");
  s.advance(600);
  await s.join(true);
  assert.deepEqual(s.texts, ["Approve me into Buzz: https://provider.test/enroll/1", "Approve me into Buzz: https://provider.test/enroll/2"]);
  s.advance(3600);
  await s.join();
  assert.equal(s.texts.length, 2, "an unforced link waits a day");
  s.advance(86_400);
  await s.join();
  assert.equal(s.texts.length, 3);
});

test("when the text fails, only the text is retried while the link is unexpired", async t => {
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => Response.json({ url: "https://provider.test/enroll/abc", expires_at: 1_000_900 }),
  }, 2);
  await assert.rejects(s.join(), /no chat/);
  s.advance(60);
  await assert.rejects(s.join(), /no chat/);
  s.advance(60);
  assert.deepEqual(await s.join(), { status: "enrolling" });
  assert.equal(s.p.calls.filter(c => c.path === "/v1/enroll").length, 1);
  assert.deepEqual(s.texts, ["Approve me into Buzz: https://provider.test/enroll/abc"]);
  assert.equal((await readState(s.dir)).enrollLink?.sentAt, 1_000_120);
  s.advance(60);
  await s.join();
  assert.equal(s.texts.length, 1, "a delivered link is not sent again");
});

test("a link that expired before it could be texted is replaced by a new enrollment", async t => {
  let n = 0;
  const s = await setup(t, {
    "/v1/attest": refuse("unknown_agent"),
    "/v1/enroll": () => { n++; return Response.json({ url: `https://provider.test/enroll/${n}`, expires_at: 1_000_000 + n * 900 }); },
  }, 1);
  await assert.rejects(s.join(), /no chat/);
  s.advance(900);
  await s.join();
  assert.equal(s.p.calls.filter(c => c.path === "/v1/enroll").length, 2);
  assert.deepEqual(s.texts, ["Approve me into Buzz: https://provider.test/enroll/2"]);
});

test("a revoked agent says so once and stops", async t => {
  const s = await setup(t, { "/v1/attest": refuse("revoked") });
  assert.deepEqual(await s.join(), { status: "revoked" });
  assert.deepEqual(await s.join(), { status: "revoked" });
  assert.deepEqual(s.texts, ["I was revoked from Buzz, so I have left it."]);
});

test("any other refusal is an error, not a state change", async t => {
  const s = await setup(t, { "/v1/attest": () => new Response("upstream down", { status: 502 }) });
  await assert.rejects(s.join(), /502/);
  assert.deepEqual(s.texts, []);
});

test("state updates are atomic and serialized, so concurrent writers lose nothing", async t => {
  const dir = await stateDir(t);
  await loadOrCreateKey(dir);
  await Promise.all([
    updateState(dir, { enrollLink: { url: "u", expiresAt: 5 } }),
    updateState(dir, { revokedNotified: true }),
  ]);
  assert.deepEqual(await readState(dir), { enrollLink: { url: "u", expiresAt: 5 }, revokedNotified: true });
  assert.deepEqual((await readdir(dir)).sort(), ["key", "state.json"], "no temp files left behind");
});
