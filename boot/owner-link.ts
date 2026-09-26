import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

type GatewayCall = (method: string, params: object, user?: string) => Promise<unknown>;
type Profile = { id: string; emails: string[] };
type Session = { key: string; owner?: { actor: { type: string; id: string } } };

const identity = { channelId: "plow", accountId: "chat", senderId: "plow-owner" };
const exec = promisify(execFile);

async function trustedProxyRelay() {
  const dir = await mkdtemp(join(tmpdir(), "plow-owner-link-"));
  try {
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    await exec("openssl", ["req", "-x509", "-newkey", "ed25519", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-days", "1"]);
    const certificate = await readFile(cert);
    const server = createServer({ key: await readFile(key), cert: certificate }, socket => {
      const gateway = connect(3000, "127.0.0.1");
      socket.pipe(gateway).pipe(socket);
      gateway.on("error", () => socket.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owner relay has no port");
    return { url: `wss://127.0.0.1:${address.port}`, fingerprint: new X509Certificate(certificate).fingerprint256,
      close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true }); } };
  } catch (error) {
    await rm(dir, { recursive: true });
    throw error;
  }
}

export async function gatewayCall(method: string, params: object, user?: string): Promise<unknown> {
  const relay = user ? await trustedProxyRelay() : undefined;
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const client = new GatewayClient({
    url: relay?.url ?? "ws://127.0.0.1:3000", password: user ? undefined : process.env.OPENCLAW_GATEWAY_PASSWORD,
    ...(relay ? { tlsFingerprint: relay.fingerprint, origin: "https://localhost",
      edgeAuthHeaders: { "X-Plow-User": user!, "X-Forwarded-For": "192.0.2.1" },
      clientName: "openclaw-control-ui", mode: "ui", platform: "web" } : {}),
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
    await relay?.close();
  }
}

export async function linkOwner(call: GatewayCall = gatewayCall): Promise<boolean> {
  const { profiles } = await call("users.list", {}) as { profiles: Profile[] };
  if (!profiles.length) return false;
  if (profiles.length !== 1 || profiles[0].emails.length !== 1) throw new Error("Expected one dashboard owner profile and login identity");
  const profile = profiles[0];
  const { links } = await call("users.listChannelIdentities", { profileId: profile.id }) as { links: { identity: typeof identity }[] };
  if (!links.some(link => link.identity.channelId === identity.channelId && link.identity.accountId === identity.accountId && link.identity.senderId === identity.senderId)) {
    await call("users.linkChannelIdentity", { profileId: profile.id, identity });
  }
  const { session } = await call("sessions.describe", { key: "agent:main:main" }, profile.emails[0]) as { session: Session | null };
  if (!session) return false;
  if (session.owner?.actor.type !== "human" || session.owner.actor.id !== profile.id) {
    await call("sessions.assignOwner", { key: session.key, owner: { type: "human", id: profile.id } }, profile.emails[0]);
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
