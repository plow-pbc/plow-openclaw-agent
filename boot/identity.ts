import { setTimeout as sleep } from "node:timers/promises";
import { type Identity } from "./config.ts";

const RETRY_MS = 3_000;
const RETRY_MAX_MS = 60_000;

// A network failure, 429 or 5xx is retried for as long as it lasts: nothing restarts boot after it gives up.
// Only an answer about the credential itself (401/403 past the grace period, 404, other 4xx) ends boot.
export async function identityFromApi(base: string, token: string): Promise<Identity> {
  const authDeadline = Date.now() + 120_000;
  let delay = RETRY_MS;
  const retry = async (reason: string) => {
    console.log(`plow-boot: identity ${reason}; retrying in ${delay / 1000}s`);
    await sleep(delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${base}/v1/agents/me`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      await retry(`request failed: ${describe(error)}`);
      continue;
    }
    if (response.ok) {
      let identity: Identity;
      try {
        identity = await response.json() as Identity;
      } catch (error) {
        // A body that arrived but is not JSON is a real answer; a body cut off in transit is not.
        if (error instanceof SyntaxError) throw error;
        await retry(`response body failed: ${describe(error)}`);
        continue;
      }
      if (!identity.line.uid) throw new Error("Identity is missing line uid");
      return identity;
    }
    if ([401, 403].includes(response.status) && Date.now() < authDeadline) {
      console.log(`plow-boot: identity HTTP ${response.status}; waiting for credential propagation`);
      await sleep(Math.min(3_000, authDeadline - Date.now()));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await retry(`HTTP ${response.status}`);
      continue;
    }
    throw new Error(`Identity request refused: HTTP ${response.status}`);
  }
}

// fetch reports every network failure as "fetch failed"; the cause says which (DNS, refused, reset, timeout).
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as (Error & { code?: string }) | undefined;
  if (!(cause instanceof Error)) return error.message;
  return `${error.message} (${[cause.code, cause.message].filter(Boolean).join(": ")})`;
}
