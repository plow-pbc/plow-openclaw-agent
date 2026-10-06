import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";

export type Scheduler = { request: (method: string, params: Record<string, unknown>) => Promise<unknown> };
// Image-installed plugins do not have the upstream bundled-plugin gateway
// privilege. Use the authenticated loopback control plane after the Plow gate.
export const scheduler: Scheduler = {
  async request(method, params) {
    if (!process.env.OPENCLAW_GATEWAY_PASSWORD) throw new Error("The local scheduler credential is unavailable");
    return await callGatewayFromCli(method, { url: "ws://127.0.0.1:3000", password: process.env.OPENCLAW_GATEWAY_PASSWORD, timeout: "10000", json: true }, params, { scopes: ["operator.admin"] });
  },
};
