import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";

/** Checks a NIP-98 header the way an attestation provider or relay does; returns the signer's pubkey. */
export function verifyNip98(header: string | undefined, request: { method: string; url: string; body?: string }): string {
  assert.match(header ?? "", /^Nostr /);
  const event = JSON.parse(Buffer.from(header!.slice(6), "base64").toString()) as NostrEvent;
  assert.equal(event.kind, 27235);
  assert.ok(verifyEvent({ ...event }), "signature");
  assert.ok(Math.abs(event.created_at - Date.now() / 1000) < 60, "fresh");
  const tag = (name: string) => event.tags.find(t => t[0] === name)?.[1];
  assert.equal(tag("u"), request.url);
  assert.equal(tag("method"), request.method);
  assert.equal(tag("payload"), request.body ? createHash("sha256").update(request.body).digest("hex") : undefined);
  return event.pubkey;
}

export const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;
export const tagFor = (n: number) => ["auth", "a".repeat(64), `created_at<${2_000_000_000 + n}`, "b".repeat(128)] as [string, string, string, string];
export const OWNER = "c2b88f74b2f2fed397726b430eb8020e514cfc6c7234bec9fa6d93f4f2769808";
