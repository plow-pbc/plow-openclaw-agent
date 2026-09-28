import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { ensureProfile, generateKey, nip98, npubOf, pubkeyOf } from "../plugin/buzz-nostr.ts";
import { headersOf, tagFor, verifyNip98 } from "./buzz-fixture.ts";

test("a generated key is hex, derives its own pubkey and shows as an npub", () => {
  const key = generateKey();
  assert.match(key.sk, /^[0-9a-f]{64}$/);
  assert.equal(pubkeyOf(key.sk), key.pk);
  assert.match(npubOf(key.pk), /^npub1[02-9ac-hj-np-z]{58}$/);
  assert.throws(() => pubkeyOf("not a key"), /64 lowercase hex/);
});

test("NIP-98 headers sign the url, method and body hash, and differ for identical requests", () => {
  const key = generateKey();
  const header = nip98(key.sk, "post", "https://provider.test/v1/enroll", '{"name":"juniper"}');
  assert.equal(verifyNip98(header, { method: "POST", url: "https://provider.test/v1/enroll", body: '{"name":"juniper"}' }), key.pk);
  assert.notEqual(nip98(key.sk, "POST", "https://x.test/", "{}"), nip98(key.sk, "POST", "https://x.test/", "{}"));
});

/** A relay's HTTP bridge holding kind 0 events, checking each request's signature and attestation. */
function relay(initial: NostrEvent[] = []) {
  const events = [...initial];
  const paths: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const path = new URL(url).pathname;
    paths.push(path);
    verifyNip98(headersOf(init).Authorization, { method: "POST", url, body });
    assert.deepEqual(JSON.parse(headersOf(init)["x-auth-tag"]!), tagFor(1));
    if (path === "/query") return Response.json(events.filter(e => JSON.parse(body)[0].authors.includes(e.pubkey)));
    const event = JSON.parse(body) as NostrEvent;
    assert.ok(verifyEvent({ ...event }));
    events.push(event);
    return Response.json({ accepted: true, message: "" });
  };
  return { events, paths, fetch: fetch as unknown as typeof globalThis.fetch };
}

test("the profile is published over the relay's HTTP bridge, then left alone while it matches", async () => {
  const key = generateKey();
  const r = relay();
  const o = { fetch: r.fetch, relayUrl: "wss://relay.test/", key, tag: tagFor(1), profile: { display_name: "Juniper", name: "juniper", about: "", picture: undefined } };
  assert.equal(await ensureProfile(o), "published");
  assert.deepEqual(r.paths, ["/query", "/events"]);
  assert.equal(r.events[0]!.kind, 0);
  assert.deepEqual(JSON.parse(r.events[0]!.content), { display_name: "Juniper", name: "juniper" });
  assert.equal(await ensureProfile(o), "unchanged");
  assert.equal(r.events.length, 1);
});

test("fields set elsewhere survive a profile update", async () => {
  const key = generateKey();
  const r = relay([{ kind: 0, pubkey: key.pk, created_at: 1, content: JSON.stringify({ name: "old", nip05: "j@example.test" }), tags: [], id: "x", sig: "y" }]);
  assert.equal(await ensureProfile({ fetch: r.fetch, relayUrl: "https://relay.test", key, tag: tagFor(1), profile: { name: "juniper" } }), "published");
  assert.deepEqual(JSON.parse(r.events.at(-1)!.content), { name: "juniper", nip05: "j@example.test" });
});
