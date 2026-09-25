import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import WebSocket from "ws";

type GatewayCall = (method: string, params: object, user?: string) => Promise<unknown>;
type Profile = { id: string; emails: string[] };
type Session = { key: string; isMain?: boolean; channel?: string; origin?: { accountId?: string }; owner?: { actor: { type: string; id: string } } };

const identity = { channelId: "plow", accountId: "chat", senderId: "plow-owner" };
const scopes = ["operator.read", "operator.write", "operator.admin"];
const devicePath = "/var/lib/plow/owner-link-device.pem";
const execFileAsync = promisify(execFile);

async function deviceKey() {
  try { return createPrivateKey(await readFile(devicePath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(devicePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    return privateKey;
  }
}

export async function gatewayCall(method: string, params: object, user?: string): Promise<unknown> {
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD;
  if (!password) throw new Error("OPENCLAW_GATEWAY_PASSWORD is required");
  if (!user) {
    const { stdout } = await execFileAsync(process.execPath, ["/app/openclaw.mjs", "gateway", "call", method, "--params", JSON.stringify(params), "--json"], { env: process.env, timeout: 15_000 });
    return JSON.parse(stdout) as unknown;
  }
  const client = { id: "openclaw-control-ui", mode: "ui", platform: "web" };
  const key = await deviceKey();
  const rawPublicKey = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
  const deviceId = createHash("sha256").update(rawPublicKey).digest("hex");
  const clientIp = Object.values(networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal)?.address;
  if (!clientIp) throw new Error("No non-loopback address for owner profile connection");
  return await new Promise((resolve, reject) => {
    // The real dashboard also reaches this loopback gateway from a different origin.
    const ws = new WebSocket("ws://127.0.0.1:3000", { origin: "https://localhost", headers: { "X-Plow-User": user, "X-Forwarded-For": clientIp } });
    const timeout = setTimeout(() => finish(new Error(`Gateway ${method} timed out`)), 15_000);
    let done = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error); else resolve(value);
    };
    ws.on("error", error => finish(error));
    ws.on("close", () => finish(new Error(`Gateway closed during ${method}`)));
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as { type: string; event?: string; id?: string; ok?: boolean; payload?: { nonce?: string }; error?: { message: string } };
      if (frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        if (!nonce) return finish(new Error("Gateway challenge has no nonce"));
        const signedAt = Date.now();
        const device = {
          id: deviceId, publicKey: rawPublicKey.toString("base64url"), signedAt, nonce,
          signature: sign(null, Buffer.from(["v3", deviceId, client.id, client.mode, "operator", scopes.join(","), String(signedAt), "", nonce, client.platform, ""].join("|")), key).toString("base64url"),
        };
        ws.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {
          minProtocol: 4, maxProtocol: 4, client: { ...client, version: "2026.9.6" }, role: "operator", scopes,
          device,
        } }));
      } else if (frame.type === "res" && frame.id === "connect") {
        if (!frame.ok) return finish(new Error(frame.error?.message ?? "Gateway connection refused"));
        ws.send(JSON.stringify({ type: "req", id: "call", method, params }));
      } else if (frame.type === "res" && frame.id === "call") {
        finish(frame.ok ? undefined : new Error(frame.error?.message ?? `Gateway ${method} failed`), frame.payload);
      }
    });
  });
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
  if (!session.isMain || session.channel !== "plow" || session.origin?.accountId !== "chat") throw new Error("Main session is not the owner Plow chat");
  if (session.owner?.actor.type !== "human" || session.owner.actor.id !== profile.id) {
    await call("sessions.assignOwner", { key: session.key, owner: { type: "human", id: profile.id } }, profile.emails[0]);
  }
  return true;
}

export function startOwnerLink() {
  const poll = async () => {
    try {
      if (await linkOwner()) { console.log("plow-boot: owner profile linked to chat and session"); return; }
    } catch (error) { console.error(`plow-boot: owner link: ${error instanceof Error ? error.message : String(error)}`); }
    setTimeout(poll, 30_000).unref();
  };
  setTimeout(poll, 30_000).unref();
}
