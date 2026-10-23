// A standby gateway for in-place upgrades (#110). Started with OPENCLAW_GATEWAY_STANDBY=1 beside the
// live gateway on the same state, it reads and admits its config (read-only, as OpenClaw's own
// admission is), preloads the modules a gateway loads after taking the state lock, tells plow-boot
// it is warm, then waits on the lock and starts the moment the old gateway exits.
//
// OpenClaw refuses a second gateway outright (exit 78, before its lock wait), and once it holds the
// lock a boot still loads most of its modules. This edits OpenClaw's built files in the image. Each
// edit names text that must occur exactly once, so an OpenClaw upgrade that moves any of it fails
// the image build instead of shipping a gateway that refuses standby or silently boots cold.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MARK = "/* plow-standby */";
const STANDBY = `process.env.OPENCLAW_GATEWAY_STANDBY === "1"`;

// Loaded by the edits below. warm() runs once; config recovery waits for the old gateway to exit.
const helper = (gatewayLock: string) => `${MARK}
// Written by plow-openclaw-agent patches/openclaw-standby.ts.
import { readFileSync } from "node:fs";
let warmed;
/** The modules a normal boot first loaded after its lock point, recorded by boot/warm-record.ts. */
export function warm() {
	return warmed ??= (async () => {
		const started = performance.now();
		const urls = readFileSync(process.env.OPENCLAW_GATEWAY_WARM_MODULES, "utf8").split("\\n").filter(Boolean);
		const loaded = (await Promise.allSettled(urls.map((url) => import(url)))).filter((result) => result.status === "fulfilled").length;
		console.log(\`[gateway] standby: warm (preloaded \${loaded}/\${urls.length} modules in \${Math.round(performance.now() - started)} ms); waiting for gateway state ownership\`);
		// plow-boot stops the old gateway on this, then the channel closes: the gateway that takes over
		// runs as one started without it.
		process.send?.("warm", () => process.connected && process.disconnect());
	})();
}
/** Hold a write OpenClaw guards only by its live-owner refusal until that owner has exited. */
export async function waitForLiveOwnerExit(env) {
	await warm();
	const { readActiveGatewayLockIdentity } = await import("./${gatewayLock}");
	while (await readActiveGatewayLockIdentity({ env })) await new Promise((resolve) => setTimeout(resolve, 50));
}
`;

type Edit = { file: RegExp; from: string; to: string };
const edits: Edit[] = [
  // The early refusal: standby goes on to admission, which only reads, and then waits on the lock.
  { file: /^doctor-startup-migration-refusal-.*\.mjs$/,
    from: `async function refuseStartupMigrationsForLiveGatewayOwner(env) {\n\tif (env.VITEST || env.NODE_ENV === "test") return;\n`,
    to: `async function refuseStartupMigrationsForLiveGatewayOwner(env) {\n\tif (env.VITEST || env.NODE_ENV === "test") return;\n\t${MARK} if (env.OPENCLAW_GATEWAY_STANDBY === "1") return;\n` },
  // Startup writes after admission: the plugin index is lease-guarded like \`openclaw plugins\` beside
  // a live gateway, but a config repair is one doctor wants the gateway stopped for, so it waits.
  { file: /^startup-config-preflight-.*\.mjs$/,
    from: `\t\tif (read.recovery || needsRefreshedPluginIndexPersistence(read)) {\n`,
    to: `\t\t${MARK} if (read.recovery && env.OPENCLAW_GATEWAY_STANDBY === "1") await (await import("./plow-standby.mjs")).waitForLiveOwnerExit(env);\n\t\tif (read.recovery || needsRefreshedPluginIndexPersistence(read)) {\n` },
  // The lock wait backs off to 2 s polls; standby polls every 50 ms so it starts on the old exit.
  { file: /^gateway-lock-.*\.mjs$/,
    from: `\t\t\tmaxPollIntervalMs: 2e3,\n`,
    to: `\t\t\tmaxPollIntervalMs: ${MARK} opts.maxPollIntervalMs ?? 2e3,\n` },
  // The lock point: standby warms up and announces itself here, and a recording boot marks it.
  { file: /^run-.*\.mjs$/,
    from: `\tlet lock = await acquireGatewayLock({\n\t\tport: params.lockPort,\n`,
    to: `\t${MARK} globalThis[Symbol.for("plow.gateway.lock-point")] = true;\n\tif (${STANDBY}) await (await import("./plow-standby.mjs")).warm();\n\tlet lock = await acquireGatewayLock({\n\t\t...${STANDBY} ? { pollIntervalMs: 50, maxPollIntervalMs: 50 } : {},\n\t\tport: params.lockPort,\n` },
];

export async function patchOpenClaw(root: string) {
  const dist = join(root, "dist");
  const names = await readdir(dist);
  // The refusal module already imports the chunk that reads the live owner's lock.
  const refusal = await readFile(join(dist, single(names.filter(name => edits[0].file.test(name)), "refusal module")), "utf8");
  const gatewayLock = single([...refusal.matchAll(/import\("\.\/(gateway-lock-[^"]+\.mjs)"\)/g)].map(match => match[1]), "gateway-lock import");
  for (const edit of edits) {
    const hits: { name: string; source: string }[] = [];
    for (const name of names.filter(name => edit.file.test(name))) {
      const source = await readFile(join(dist, name), "utf8");
      if (source.includes(edit.to)) hits.push({ name, source: "" });
      else if (source.split(edit.from).length === 2) hits.push({ name, source });
      else if (source.includes(edit.from)) throw new Error(`openclaw-standby: ${name} has ${JSON.stringify(edit.from.trim().slice(0, 60))} more than once`);
    }
    const hit = single(hits, `${edit.file} ${JSON.stringify(edit.from.trim().slice(0, 60))}`);
    if (hit.source) await writeFile(join(dist, hit.name), hit.source.replace(edit.from, edit.to));
  }
  await writeFile(join(dist, "plow-standby.mjs"), helper(gatewayLock));
}

function single<T>(found: T[], what: string): T {
  if (found.length !== 1) throw new Error(`openclaw-standby: expected exactly one ${what}, found ${found.length}`);
  return found[0];
}

if (import.meta.main) {
  await patchOpenClaw(process.argv[2] ?? "/app");
  console.log("openclaw-standby: patched");
}
