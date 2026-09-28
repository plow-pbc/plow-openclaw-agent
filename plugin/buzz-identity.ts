// The agent's Buzz identity: its own Nostr key (created once, kept in the state volume), enrollment with the
// attestation provider, and the NIP-OA attestation that admits it to the provider's relay as its owner's
// agent. The key never goes into env, argv or logs of the gateway.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { generateKey, nip98, pubkeyOf, type AuthTag, type Key } from "./buzz-nostr.ts";

export type { AuthTag, Key };
export type State = {
  /** The newest enrollment link; `sentAt` once the owner has it, so a failed text is retried without enrolling again. */
  enrollLink?: { url: string; expiresAt: number; sentAt?: number };
  revokedNotified?: boolean;
};
export type Joined = { status: "attested"; tag: AuthTag; expiresAt: number } | { status: "enrolling" } | { status: "revoked" };

/** An unanswered enrollment link is replaced once a day, not every time the agent checks. */
export const ENROLL_RESEND_SECONDS = 24 * 60 * 60;

export async function loadOrCreateKey(dir: string): Promise<Key> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  try {
    const sk = (await readFile(`${dir}/key`, "utf8")).trim();
    return { sk, pk: pubkeyOf(sk) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = generateKey();
  await writeFile(`${dir}/key`, `${key.sk}\n`, { mode: 0o600, flag: "wx" });
  return key;
}

export async function readState(dir: string): Promise<State> {
  try { return JSON.parse(await readFile(`${dir}/state.json`, "utf8")) as State; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

// OpenClaw loads the channel and tool execution in separate module instances, so the queue lives on globalThis.
const shared = globalThis as typeof globalThis & { buzzStateQueue?: Promise<unknown> };

/**
 * Merges `change` into state.json. Updates run one at a time (the channel and the buzz_enroll tool both
 * write), and each replaces the file by rename, so a crash never leaves it half written.
 */
export function updateState(dir: string, change: Partial<State>): Promise<State> {
  const run = (shared.buzzStateQueue ?? Promise.resolve()).then(async () => {
    const next = { ...(await readState(dir)), ...change };
    await writeFile(`${dir}/state.json.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${dir}/state.json.tmp`, `${dir}/state.json`);
    return next;
  });
  shared.buzzStateQueue = run.catch(() => {});
  return run;
}

class ProviderError extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined, message: string) { super(message); this.code = code; }
}

async function call<T>(fetch: typeof globalThis.fetch, provider: string, key: Key, path: string, body: unknown): Promise<T> {
  const url = `${provider.replace(/\/+$/, "")}${path}`;
  const text = JSON.stringify(body);
  const response = await fetch(url, { method: "POST", headers: { Authorization: nip98(key.sk, "POST", url, text), "Content-Type": "application/json" }, body: text });
  const raw = await response.text();
  let json: { error?: string } | null = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  if (!response.ok) throw new ProviderError(json?.error, `attestation provider ${path}: HTTP ${response.status} ${json?.error ?? raw.slice(0, 200)}`);
  return json as T;
}

export type JoinOptions = {
  /** The channel's state directory (key, state.json, auth-tag). */
  dir: string;
  key: Key;
  provider: string;
  /** What the owner sees on the approval page: the agent's handle and what it claims to run. */
  enroll: { name: string; harness: string; model: string };
  notifyOwner: (text: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** The owner asked for a fresh link: send one as soon as the last has expired. */
  force?: boolean;
};

/**
 * Attests when the provider knows this key, caching the tag for the buzz CLI; otherwise enrolls and texts
 * the owner the approval link, at most once per ENROLL_RESEND_SECONDS unless `force`. If the text fails
 * (the owner has no chat yet), the unexpired link is kept and only the text is retried. A revoked key tells
 * the owner once.
 */
export async function joinBuzz(o: JoinOptions): Promise<Joined> {
  const fetch = o.fetch ?? globalThis.fetch;
  const now = o.now?.() ?? Math.floor(Date.now() / 1000);
  try {
    const r = await call<{ tag: AuthTag; expires_at: number }>(fetch, o.provider, o.key, "/v1/attest", {});
    await writeFile(`${o.dir}/auth-tag`, JSON.stringify(r.tag), { mode: 0o600 });
    await chmod(`${o.dir}/auth-tag`, 0o600);
    return { status: "attested", tag: r.tag, expiresAt: r.expires_at };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const state = await readState(o.dir);
    if (error.code === "revoked") {
      if (!state.revokedNotified) {
        await o.notifyOwner("I was revoked from Buzz, so I have left it.");
        await updateState(o.dir, { revokedNotified: true });
      }
      return { status: "revoked" };
    }
    if (error.code !== "unknown_agent") throw error;
    let link = state.enrollLink;
    if (link && now < link.expiresAt) {
      if (link.sentAt !== undefined) return { status: "enrolling" };
    } else {
      const since = link?.sentAt === undefined ? Infinity : now - link.sentAt;
      if (since < ENROLL_RESEND_SECONDS && !o.force) return { status: "enrolling" };
      const r = await call<{ url: string; expires_at: number }>(fetch, o.provider, o.key, "/v1/enroll", o.enroll);
      link = { url: r.url, expiresAt: r.expires_at };
      await updateState(o.dir, { enrollLink: link });
    }
    await o.notifyOwner(`Approve me into Buzz: ${link.url}`);
    await updateState(o.dir, { enrollLink: { ...link, sentAt: now } });
    return { status: "enrolling" };
  }
}
