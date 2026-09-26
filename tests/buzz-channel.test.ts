import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { NostrEvent } from "nostr-tools/pure";
import { createBuzzChannel } from "../plugin/buzz.ts";
import { loadOrCreateKey } from "../plugin/buzz-identity.ts";
import { headersOf, OWNER, tagFor, verifyNip98 } from "./buzz-fixture.ts";

const now = () => Math.floor(Date.now() / 1000);

/** An attestation provider (https://provider.test) and the relay it names (https://relay.test). */
function world(attest: () => Response) {
  const events: NostrEvent[] = [];
  const enrolls: unknown[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/v1/info") return Response.json({ relay_url: "https://relay.test" });
    const body = String(init?.body ?? "");
    verifyNip98(headersOf(init).Authorization, { method: "POST", url, body });
    if (url.startsWith("https://provider.test")) {
      if (path === "/v1/attest") return attest();
      enrolls.push(JSON.parse(body));
      return Response.json({ url: "https://provider.test/enroll/x", expires_at: now() + 900 });
    }
    if (path === "/query") return Response.json(events.filter(e => JSON.parse(body)[0].authors.includes(e.pubkey)));
    events.push(JSON.parse(body));
    return Response.json({ accepted: true, message: "" });
  };
  return { events, enrolls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const cfg = {
  gateway: { port: 3000 },
  agents: { defaults: { model: { primary: "plow/z-ai/glm-5.2" } } },
  channels: { buzz: {
    provider: "https://provider.test", respondTo: [OWNER], name: "Juniper", handle: "juniper",
    about: "Plans your week", avatar: "https://example.test/juniper.png",
  } },
};

async function run(t: TestContext, w: ReturnType<typeof world>, opts: { until: (starts: Record<string, string>[], texts: string[]) => boolean; reattestSeconds?: number }) {
  const root = await mkdtemp(`${tmpdir()}/buzz-channel-`);
  t.after(() => rm(root, { recursive: true }));
  await writeFile(`${root}/gateway-password`, "per-boot-password\n", { mode: 0o600 });
  const starts: Record<string, string>[] = [];
  const texts: string[] = [];
  const logs: string[] = [];
  let stopped = false;
  const channel = createBuzzChannel({
    notifyOwner: async (_cfg, text) => { texts.push(text); },
    fetch: w.fetch, stateDir: () => root, retryMs: 5, reattestSeconds: opts.reattestSeconds,
    supervise: ({ env, signal }) => {
      starts.push(env);
      const done = new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
      return { restart: env => { starts.push(env); }, done };
    },
  });
  const controller = new AbortController();
  const timer = setInterval(() => { if (opts.until(starts, texts)) controller.abort(); }, 5);
  const deadline = setTimeout(() => controller.abort(), 4000);
  await channel.gateway!.startAccount!({ account: channel.config.resolveAccount(cfg as never, "default"), cfg, abortSignal: controller.signal, log: { info: (s: string) => logs.push(s) } } as never);
  clearInterval(timer); clearTimeout(deadline);
  return { root, starts, texts, logs, stopped: () => stopped };
}

test("an attested agent names itself, then runs buzz-acp against the provider's relay and this gateway", async t => {
  const w = world(() => Response.json({ tag: tagFor(1), expires_at: now() + 86400 }));
  const r = await run(t, w, { until: starts => starts.length > 0 });
  const key = await loadOrCreateKey(`${r.root}/buzz`);
  assert.equal(r.starts.length, 1);
  const env = r.starts[0]!;
  assert.equal(env.BUZZ_RELAY_URL, "wss://relay.test");
  assert.equal(env.BUZZ_PRIVATE_KEY, key.sk);
  assert.equal(env.BUZZ_AUTH_TAG, JSON.stringify(tagFor(1)));
  assert.equal(env.BUZZ_ACP_RESPOND_TO_ALLOWLIST, OWNER);
  assert.equal(env.BUZZ_ACP_AGENT_ARGS, `/app/openclaw.mjs,acp,--url,ws://127.0.0.1:3000,--password-file,${r.root}/gateway-password`);
  assert.equal((await readFile(`${r.root}/buzz/relay-url`, "utf8")).trim(), "https://relay.test");
  const profile = w.events.find(e => e.kind === 0)!;
  assert.equal(profile.pubkey, key.pk);
  assert.deepEqual(JSON.parse(profile.content), { display_name: "Juniper", name: "juniper", about: "Plans your week", picture: "https://example.test/juniper.png" });
  assert.ok(r.stopped(), "buzz-acp stops with the gateway");
  assert.ok(!r.logs.some(l => l.includes(key.sk)), "the key never reaches the log");
});

test("each fresh attestation restarts buzz-acp with the new tag", async t => {
  let n = 0;
  const w = world(() => Response.json({ tag: tagFor(++n), expires_at: now() + 86400 }));
  const r = await run(t, w, { reattestSeconds: 0, until: starts => starts.length >= 2 });
  assert.equal(r.starts[0]!.BUZZ_AUTH_TAG, JSON.stringify(tagFor(1)));
  assert.equal(r.starts[1]!.BUZZ_AUTH_TAG, JSON.stringify(tagFor(2)));
});

test("an agent waiting for approval texts the owner, claims the configured model, and runs nothing", async t => {
  const w = world(() => Response.json({ error: "unknown_agent", message: "enroll first" }, { status: 403 }));
  const r = await run(t, w, { until: (_s, texts) => texts.length > 0 });
  assert.deepEqual(r.texts, ["Approve me into Buzz: https://provider.test/enroll/x"]);
  assert.deepEqual(w.enrolls, [{ name: "juniper", harness: "openclaw", model: "plow/z-ai/glm-5.2" }]);
  assert.equal(r.starts.length, 0);
});

test("a revoked agent runs nothing and returns", async t => {
  const w = world(() => Response.json({ error: "revoked", message: "revoked" }, { status: 403 }));
  const r = await run(t, w, { until: () => false });
  assert.equal(r.starts.length, 0);
  assert.deepEqual(r.texts, ["I was revoked from Buzz, so I have left it."]);
});
