// Loaded with --import into a gateway at image build: lists each module it first loads after its
// lock point (marked by patches/openclaw-standby.ts) in $OPENCLAW_GATEWAY_WARM_RECORD. A standby
// gateway imports that list while it waits, so taking over does not load them.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const file = process.env.OPENCLAW_GATEWAY_WARM_RECORD;
const lockPoint = Symbol.for("plow.gateway.lock-point");
if (file) {
  const before = new Set<string>();
  const recorded = new Set<string>();
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      // A module loaded before the lock point may be one the standby is still evaluating when it
      // warms, and importing that would wait on itself. Plugin copies get a new path each boot, and a
      // query is a per-boot cache-buster: preloading either would only add a copy.
      if (!(globalThis as Record<symbol, unknown>)[lockPoint]) before.add(url);
      else if (url.startsWith("file:") && !url.includes("?") && !before.has(url) && !recorded.has(url) && !url.includes("/plugin-captures/")) {
        recorded.add(url);
        appendFileSync(file, url + "\n");
      }
      return result;
    },
  });
}
