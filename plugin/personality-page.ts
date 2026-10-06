import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { personalityAxes, personalitySchema, personalityInstructions } from "../boot/personality.ts";
import { readExperience, updateExperience } from "./experience-state.ts";
import type { Account } from "./transport.ts";

const path = "/plugins/plow/personality";
export const personalityRevision = (personality: unknown) => createHash("sha256").update(JSON.stringify(personality ?? null)).digest("hex");
const inputSchema = z.object({ action: z.enum(["save", "reset", "preview"]), sliders: personalitySchema.optional(), revision: z.string().optional() }).strict();

export function installPersonalityPage(api: OpenClawPluginApi) {
  api.registerHttpRoute?.({ path, match: "prefix", auth: "gateway", gatewayRuntimeScopeSurface: "write-default", handler: async (req, res) => {
    const account = api.config.channels?.plow as Account;
    if (!account) { res.writeHead(503).end("Plow configuration is unavailable"); return; }
    const scope = { account, conversation: "agent" };
    const route = new URL(req.url ?? path, "http://localhost").pathname;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "GET" && (route === path || route === `${path}/`)) {
      const nonce = randomBytes(16).toString("base64");
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end((await readFile(new URL("./personality-ui.html", import.meta.url), "utf8")).replaceAll("NONCE", nonce)); return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (route !== `${path}/api`) { res.writeHead(404).end(JSON.stringify({ error: "Not found" })); return; }
    const payload = async () => {
      const state = await readExperience(scope);
      const sliders = state.personality ?? personalitySchema.parse(account.personalityDefaults ?? {});
      return { saved: !!state.personality, revision: personalityRevision(state.personality), sliders, axes: personalityAxes.map(({ id, left, right }) => ({ id, left, right })), preview: state.personality ? personalityInstructions(sliders) : "Builder personality is active. Saving these sliders will apply a public voice override." };
    };
    try {
      if (req.method === "GET") { res.end(JSON.stringify(await payload())); return; }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "GET, POST" }).end(JSON.stringify({ error: "Method not allowed" })); return; }
      // JSON plus a custom header prevents a cross-site form from changing voice.
      if (req.headers["x-agent-personality"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")) { res.writeHead(403).end(JSON.stringify({ error: "Use the personality settings page" })); return; }
      if (req.headers.origin) {
        const allowed = new Set(["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:3000", "http://127.0.0.1:3000"]);
        if (account.dashboardUrl) allowed.add(new URL(account.dashboardUrl).origin);
        if (!allowed.has(req.headers.origin)) { res.writeHead(403).end(JSON.stringify({ error: "Unexpected settings origin" })); return; }
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > 8192) throw new Error("Settings request is too large"); chunks.push(chunk); }
      const input = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (input.action === "preview") { res.end(JSON.stringify({ preview: personalityInstructions(personalitySchema.parse(input.sliders)) })); return; }
      let current = true;
      const closed = () => { current = false; };
      req.once("aborted", closed); res.once("close", closed);
      await updateExperience(scope, () => { if (!current || req.socket.destroyed) throw new Error("Settings request ended before saving"); }, state => {
        if (input.revision !== personalityRevision(state.personality)) throw new Error("Settings changed in another session; reload before saving");
        if (input.action === "reset") delete state.personality;
        else state.personality = personalitySchema.parse(input.sliders);
      });
      api.logger.info(`plow personality ${input.action} via owner dashboard`);
      res.end(JSON.stringify(await payload()));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Settings could not be saved";
      res.writeHead(message.startsWith("Settings changed") ? 409 : 400).end(JSON.stringify({ error: message }));
    }
  } });
}
