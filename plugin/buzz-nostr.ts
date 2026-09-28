// The little Nostr the Buzz channel needs, on nostr-tools: the agent's key, NIP-98 request signing (for the
// attestation provider and the relay's HTTP bridge) and the agent's kind 0 profile on the relay.
import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";

export type Key = { sk: string; pk: string };
/** A NIP-OA attestation: ["auth", owner pubkey, conditions, signature]. */
export type AuthTag = [string, string, string, string];
export type Profile = { display_name?: string; name?: string; about?: string; picture?: string };

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

export function generateKey(): Key {
  const sk = generateSecretKey();
  return { sk: Buffer.from(sk).toString("hex"), pk: getPublicKey(sk) };
}

export function pubkeyOf(sk: string): string {
  if (!/^[0-9a-f]{64}$/.test(sk)) throw new Error("the Buzz key must be 64 lowercase hex characters");
  return getPublicKey(bytes(sk));
}

/** For logs: the public key in the form Buzz shows people. */
export const npubOf = (pk: string) => npubEncode(pk);

function sign(sk: string, template: Omit<EventTemplate, "created_at">): NostrEvent {
  return finalizeEvent({ ...template, created_at: Math.floor(Date.now() / 1000) }, bytes(sk));
}

/**
 * An `Authorization` header for one request (NIP-98, kind 27235). The nonce keeps two identical requests in
 * the same second distinct, since servers refuse a replayed event id.
 */
export function nip98(sk: string, method: string, url: string, body?: string): string {
  const tags = [["u", url], ["method", method.toUpperCase()], ["nonce", randomUUID()]];
  if (body) tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  return `Nostr ${Buffer.from(JSON.stringify(sign(sk, { kind: 27235, content: "", tags }))).toString("base64")}`;
}

/** The relay's HTTP bridge: POST /query and /events, signed by the agent and carrying its attestation. */
async function relayPost(fetch: typeof globalThis.fetch, relayUrl: string, key: Key, tag: AuthTag, path: string, body: string): Promise<unknown> {
  const url = `${relayUrl.replace(/^ws(s?):/, "http$1:").replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, { method: "POST", body, headers: {
    Authorization: nip98(key.sk, "POST", url, body), "Content-Type": "application/json", "x-auth-tag": JSON.stringify(tag),
  } });
  const text = await response.text();
  if (!response.ok) throw new Error(`relay ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Makes the relay's kind 0 profile for this key carry `wanted`. The relay keeps kind 0 as one whole
 * document, so fields set elsewhere (by the owner in the Buzz app, say) are merged, not dropped.
 */
export async function ensureProfile(o: { fetch: typeof globalThis.fetch; relayUrl: string; key: Key; tag: AuthTag; profile: Profile }): Promise<"published" | "unchanged"> {
  const found = await relayPost(o.fetch, o.relayUrl, o.key, o.tag, "/query", JSON.stringify([{ kinds: [0], authors: [o.key.pk], limit: 1 }]));
  if (!Array.isArray(found)) throw new Error("relay /query did not return a list");
  const newest = (found as NostrEvent[]).reduce<NostrEvent | undefined>((a, e) => a && a.created_at >= e.created_at ? a : e, undefined);
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(newest?.content ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch { /* an unreadable profile is replaced */ }
  const wanted = Object.fromEntries(Object.entries(o.profile).filter(([, v]) => typeof v === "string" && v !== ""));
  if (newest && Object.entries(wanted).every(([k, v]) => current[k] === v)) return "unchanged";
  const event = sign(o.key.sk, { kind: 0, content: JSON.stringify({ ...current, ...wanted }), tags: [] });
  const sent = await relayPost(o.fetch, o.relayUrl, o.key, o.tag, "/events", JSON.stringify(event)) as { accepted?: boolean; message?: string } | null;
  if (sent?.accepted !== true) throw new Error(`relay did not accept the profile: ${sent?.message ?? "no reason given"}`);
  return "published";
}
