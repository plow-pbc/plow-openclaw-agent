// The Buzz channel: this agent in a Buzz community as its owner's agent, opted in by the image
// (BUZZ_ATTESTATION_PROVIDER, see boot/config.ts). It keeps the agent's own key, enrolls with the attestation
// provider (the owner approves a link texted on the Plow line), attests daily, names itself, and runs Block's
// buzz-acp against this gateway so that mentions and DMs in Buzz become turns the agent answers with the
// buzz CLI. Without the opt-in there is no channels.buzz config and this channel has no account to start.
import { access, constants, writeFile } from "node:fs/promises";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { ensureProfile, npubOf } from "./buzz-nostr.ts";
import { joinBuzz, loadOrCreateKey, type Joined } from "./buzz-identity.ts";
import { acpEnv, superviseAcp, type Supervisor } from "./buzz-acp.ts";

export type BuzzAccount = {
  accountId: string;
  /** The attestation provider's base URL: GET /v1/info, POST /v1/enroll and POST /v1/attest. */
  provider: string;
  /** Hex pubkeys whose messages start turns besides the attesting owner. */
  respondTo: string[];
  name: string;
  handle: string;
  about: string;
  avatar?: string;
};

type Deps = {
  notifyOwner: (cfg: OpenClawConfig, text: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  stateDir?: () => string;
  supervise?: typeof superviseAcp;
  /** Base delay between failed attempts. */
  retryMs?: number;
  reattestSeconds?: number;
};

/** Attest well before a 24-hour tag runs out. */
const REATTEST_SECONDS = 20 * 60 * 60;
const ENROLLING_RECHECK_SECONDS = 30;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done);
});

export const stateDirOf = () => process.env.OPENCLAW_STATE_DIR ?? "/var/lib/plow";

export function resolveBuzzAccount(cfg: OpenClawConfig | undefined): BuzzAccount | undefined {
  const buzz = cfg?.channels?.buzz as Omit<BuzzAccount, "accountId"> | undefined;
  return buzz?.provider ? { ...buzz, accountId: "default" } : undefined;
}

/** What the agent claims to run, shown to the owner on the approval page: the configured primary model. */
export function enrollClaim(cfg: OpenClawConfig, account: BuzzAccount) {
  const model = cfg.agents?.defaults?.model;
  const primary = typeof model === "string" ? model : model?.primary;
  return { name: account.handle, harness: "openclaw", model: primary ?? "unknown" };
}

/** Joins with the account's provider; the buzz_enroll tool uses this too, with `force`. */
export function join(cfg: OpenClawConfig, account: BuzzAccount, o: { notifyOwner: (text: string) => Promise<void>; fetch?: typeof globalThis.fetch; stateDir?: string; force?: boolean }): Promise<Joined> {
  const dir = `${o.stateDir ?? stateDirOf()}/buzz`;
  return loadOrCreateKey(dir).then(key => joinBuzz({
    dir, key, provider: account.provider, fetch: o.fetch, force: o.force, notifyOwner: o.notifyOwner, enroll: enrollClaim(cfg, account),
  }));
}

export function createBuzzChannel(deps: Deps): ChannelPlugin<BuzzAccount> {
  const now = () => Math.floor(Date.now() / 1000);
  const stateDir = deps.stateDir ?? stateDirOf;
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const supervise = deps.supervise ?? superviseAcp;
  const retryMs = deps.retryMs ?? 3000;
  const reattestSeconds = deps.reattestSeconds ?? REATTEST_SECONDS;

  async function relayUrlOf(provider: string): Promise<string> {
    const response = await fetch(`${provider.replace(/\/+$/, "")}/v1/info`).catch((error: Error) => {
      throw new Error(`attestation provider unreachable: ${error.message}`);
    });
    if (!response.ok) throw new Error(`attestation provider /v1/info: HTTP ${response.status}`);
    const info = await response.json() as { relay_url?: unknown };
    if (typeof info.relay_url !== "string" || !info.relay_url) throw new Error("attestation provider /v1/info has no relay_url");
    return info.relay_url;
  }

  return {
    id: "buzz",
    meta: { id: "buzz", label: "Buzz", selectionLabel: "Buzz", docsPath: "/channels/buzz", blurb: "A Buzz community, through buzz-acp" },
    capabilities: { chatTypes: ["group"], media: false },
    config: {
      listAccountIds: cfg => resolveBuzzAccount(cfg) ? ["default"] : [],
      resolveAccount: cfg => resolveBuzzAccount(cfg) ?? { accountId: "default", provider: "", respondTo: [], name: "", handle: "", about: "" },
      isConfigured: account => Boolean(account.provider),
      formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
    },
    gateway: {
      startAccount: async ctx => {
        const account = ctx.account;
        const signal = ctx.abortSignal;
        const log = (text: string) => ctx.log?.info(text);
        const dir = `${stateDir()}/buzz`;
        const key = await loadOrCreateKey(dir);
        log(`buzz: identity ${npubOf(key.pk)}`);
        let relayUrl: string | null = null;
        let supervisor: Supervisor | null = null;
        let failures = 0;
        while (!signal.aborted) {
          try {
            if (!relayUrl) {
              relayUrl = await relayUrlOf(account.provider);
              // The buzz wrapper reads it, so the image names no relay of its own.
              await writeFile(`${dir}/relay-url`, `${relayUrl}\n`, { mode: 0o600 });
            }
            const joined = await join(ctx.cfg, account, { fetch, stateDir: stateDir(), notifyOwner: text => deps.notifyOwner(ctx.cfg, text) });
            failures = 0;
            if (joined.status === "revoked") { log("buzz: revoked; not joining"); break; }
            if (joined.status === "enrolling") {
              log("buzz: waiting for the owner to approve enrollment");
              await sleep(ENROLLING_RECHECK_SECONDS * 1000, signal);
              continue;
            }
            await ensureProfile({ fetch, relayUrl, key, tag: joined.tag, profile: {
              display_name: account.name, name: account.handle, about: account.about, picture: account.avatar,
            } }).catch(error => log(`buzz: profile: ${(error as Error).message}`));
            // boot/main.ts writes this per-boot password; OpenClaw accepts it on direct loopback connections.
            const passwordFile = `${stateDir()}/gateway-password`;
            await access(passwordFile, constants.R_OK);
            const env = acpEnv({ relayUrl, key, tag: joined.tag, gatewayPort: ctx.cfg.gateway?.port ?? 3000, passwordFile, respondTo: account.respondTo ?? [] });
            if (supervisor) supervisor.restart(env);
            else supervisor = supervise({ env, signal, log });
            log(`buzz: attested until ${joined.expiresAt}; buzz-acp running`);
            // Re-attest at REATTEST_SECONDS, or halfway through a shorter-lived tag.
            await sleep(Math.max(Math.min(reattestSeconds, (joined.expiresAt - now()) / 2) * 1000, retryMs), signal);
          } catch (error) {
            failures++;
            log(`buzz: ${(error as Error).message}`);
            await sleep(Math.min(60_000, retryMs * 2 ** Math.min(failures, 10)), signal);
          }
        }
        if (supervisor) await supervisor.done;
      },
    },
  };
}
