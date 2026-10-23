import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// #104: the first real agent bug report was a browse task where the agent never read the
// camoufox-browsing skill and drove Safari through AppleScript, raising screen-capture prompts.
// A bundled skill surfaces the rule on browser work, where the model looks for how to act.
const skill = await readFile(new URL("../skills/browsing/SKILL.md", import.meta.url), "utf8");

test("the browsing skill triggers on browser work and names the Mac skill to read first", () => {
  assert.match(skill, /^name:\s*browsing$/m);
  const description = /^description:\s*(.+)$/m.exec(skill)?.[1] ?? "";
  for (const cue of ["website", "form", "CAPTCHA", "camoufox-browsing"]) assert.ok(description.includes(cue), cue);
});

test("the browsing skill says to read camoufox-browsing before the first plow_browser call", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("read it (plow_read_skill) before your first plow_browser call this turn"));
  assert.match(flat, /Read it for the fallbacks, not the happy path/);
  assert.match(flat, /Safari `do JavaScript` recipe/);
});

test("the browsing skill forbids AppleScript Safari and screen capture as a workaround", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("Do not drive Safari or any other app through plow_run_applescript UI scripting"));
  assert.match(flat, /do not capture the owner's screen/);
});

test("the browsing skill keeps improvising as a said-aloud last resort, not an absolute ban", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("only when no Latch tool and no fallback in the skill can do the job"));
  assert.match(flat, /tell the person what you are doing and why, in one short line, before you do it/);
});
