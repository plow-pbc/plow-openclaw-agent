import { renderConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";

// Exercise the policy shipped in the pinned runtime image.
const { r: enforceCrossContextPolicy } = await import("/app/dist/outbound-policy-CxNjGIGu.mjs");
const cfg = renderConfig(probeIdentity, "http://fixture");
export function nativeSendPolicy(current: string, target: string, provider = "plow") {
  enforceCrossContextPolicy({ cfg, channel: "plow", action: "send", args: { to: target },
    toolContext: { currentChannelProvider: provider, currentChannelId: current } });
}
