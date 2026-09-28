import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

type GatewayCall = (method: string, params: object) => Promise<unknown>;
type Profile = { id: string };
type Session = { key: string; owner?: { actor: { type: string; id: string } } };
type ToolResult = { ok: boolean; error?: { message: string } };

const identity = { channelId: "plow", accountId: "chat", senderId: "plow-owner" };

export async function gatewayCall(method: string, params: object): Promise<unknown> {
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const client = new GatewayClient({
    url: "ws://127.0.0.1:3000", password: process.env.OPENCLAW_GATEWAY_PASSWORD,
    role: "operator", scopes: ["operator.admin"], requestTimeoutMs: 15_000,
    onHelloOk: ready, onConnectError: fail,
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    client.start();
    await Promise.race([connected, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Gateway connection timed out")), 15_000);
    })]);
    return await client.request(method, params);
  } finally {
    clearTimeout(timeout);
    await client.stopAndWait();
  }
}

export async function linkOwner(call: GatewayCall = gatewayCall): Promise<boolean> {
  const { profiles } = await call("users.list", {}) as { profiles: Profile[] };
  if (!profiles.length) return false;
  if (profiles.length !== 1) throw new Error("Expected one dashboard owner profile");
  const profile = profiles[0];
  const { links } = await call("users.listChannelIdentities", { profileId: profile.id }) as { links: { identity: typeof identity }[] };
  if (!links.some(link => link.identity.channelId === identity.channelId && link.identity.accountId === identity.accountId && link.identity.senderId === identity.senderId)) {
    await call("users.linkChannelIdentity", { profileId: profile.id, identity });
  }
  const { session } = await call("sessions.describe", { key: "agent:main:main" }) as { session: Session | null };
  if (!session) return false;
  if (session.owner?.actor.type !== "human" || session.owner.actor.id !== profile.id) {
    const result = await call("tools.invoke", { name: "sessions", sessionKey: "agent:main:main",
      args: { action: "assign_owner", sessionKey: session.key, ownerType: "human", ownerId: profile.id } }) as ToolResult;
    if (!result.ok) throw new Error(`Owner assignment failed: ${result.error?.message ?? "unknown tool error"}`);
  }
  return true;
}

export function startOwnerLink(call: GatewayCall = gatewayCall) {
  const poll = async () => {
    try {
      if (await linkOwner(call)) { console.log("plow-boot: owner profile linked to chat and session"); return; }
    } catch (error) {
      console.error(`plow-boot: owner link: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(poll, 300_000).unref();
  };
  setTimeout(poll, 300_000).unref();
}
