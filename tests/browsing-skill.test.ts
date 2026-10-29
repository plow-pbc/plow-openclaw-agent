import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// #104: the first real agent bug report was a browse task where the agent never read the browser
// recipe and improvised around a page, raising screen-capture prompts. A bundled skill surfaces
// the rule on browser work, where the model looks for how to act.
const skill = await readFile(new URL("../skills/browsing/SKILL.md", import.meta.url), "utf8");

test("the browsing skill triggers on browser work and names the latch skill to read first", () => {
  assert.match(skill, /^name:\s*browsing$/m);
  const description = /^description:\s*(.+)$/m.exec(skill)?.[1] ?? "";
  for (const cue of ["website", "form", "sign-in code", "latch skill"]) assert.ok(description.includes(cue), cue);
});

test("the browsing skill says to read the latch skill before the first latch browser call", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("Read the latch skill before your first `latch browser` call this turn, even when the site looks simple."));
});

const owners = await readFile(new URL("../skills/owners-mac/SKILL.md", import.meta.url), "utf8");

test("the owners-mac skill reads texts with latch and texts people from the agent's own line", () => {
  const flat = owners.replace(/\s+/g, " ");
  assert.ok(flat.includes("On their Mac, the `latch messages` commands read the owner's texts and `latch contacts` their address book."));
  assert.ok(flat.includes("To text someone, start a thread from your own line with plow_start_thread."));
});
