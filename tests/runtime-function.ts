import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const runtimeDist = dirname(require.resolve("openclaw"));

// These internal functions in the pinned runtime are not plugin SDK exports.
export async function runtimeFunction(prefix: string, name: string) {
  for (const file of (await readdir(runtimeDist)).filter(file => file.startsWith(prefix) && file.endsWith(".mjs"))) {
    const module = await import(pathToFileURL(join(runtimeDist, file)).href);
    const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
    if (typeof fn === "function") return fn;
  }
  throw new Error(`Pinned OpenClaw runtime is missing ${name}`);
}
