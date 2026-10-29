import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { renderPrompt } from "../boot/prompt.ts";

const prompt = await readFile(new URL("../prompt/AGENTS.md", import.meta.url), "utf8");

test("the default thread trust instruction renders", () => {
  assert.match(renderPrompt(prompt), /ask the owner whether the group should have full trust/i);
});

for (const [mode, expected] of [
  ["ask", /ask the owner whether the group should have full trust/i],
  ["trusted", /create groups with trusted: true/i],
  ["untrusted", /create groups with trusted: false/i],
] as const) test(`thread trust mode ${mode} renders its instruction`, () => {
  const rendered = renderPrompt(prompt, mode);
  assert.match(rendered, expected);
  if (mode !== "ask") assert.doesNotMatch(rendered, /ask the owner whether the group should have full trust/i);
});

// plow#2366: narration texted to a phone is noise and costs tokens.
test("the prompt asks for results, not a running narration", () => {
  assert.match(prompt, /Text results, not a running narration of the work\./);
  assert.match(prompt, /no progress notes between steps/);
});

test("invalid thread trust mode fails at boot", () => {
  assert.throws(() => renderPrompt(prompt, "unknown"), /PLOW_THREAD_TRUST/);
});

test("dashboard address comes from agent identity, including absence", () => {
  const base = renderPrompt(prompt, "ask", null);
  assert.equal(renderPrompt(prompt, "ask", "https://dashboard.example/agent"),
    base.replace("\nYou have no dashboard. Say so when asked for its URL; never guess one.\n",
      "\nYour dashboard is https://dashboard.example/agent. Give that exact address when asked; never guess a dashboard URL.\n"));
  assert.match(base, /You have no dashboard. Say so when asked for its URL/);
});

test("the prompt sends thanks, praise and ideas as report_bug feedback", () => {
  const flat = prompt.replace(/\s+/g, " ");
  assert.ok(flat.includes("Thanks, praise or an idea the person asks you to pass to your developers is feedback, not a problem: call report_bug with kind feedback"));
});

test("the prompt reaches the owner's machines through latch and its skill, naming the host", () => {
  const flat = prompt.replace(/\s+/g, " ");
  assert.ok(flat.includes("Before any task on the owner's machines, read the latch skill and follow it in this turn."));
  assert.ok(flat.includes("Run `latch status` to see their hosts: the cloud computer is the host named `cloud`."));
  assert.ok(flat.includes("With more than one host, pass `--host` with the host's name on every command, and ask the owner which one when the task does not say; never guess."));
  assert.ok(flat.includes("latch has no way to script the owner's apps or capture their screen: when a task needs that, say it is not available."));
});

test("the prompt tells the owner how to set latch up, and waits out an offline host", () => {
  const flat = prompt.replace(/\s+/g, " ");
  assert.ok(flat.includes("When latch answers `no_host`, the owner has no machine set up for you yet"));
  assert.ok(flat.includes("`curl -fsSLO https://releases.plow.co/latch-cli/install.sh && sh install.sh`"));
  assert.ok(flat.includes("ask the owner to start latch on that machine only after it fails on two turns a few minutes apart"));
});

test("the prompt attaches files from the agent's machine, never a path on a host", () => {
  const flat = prompt.replace(/\s+/g, " ");
  // #116: the agent wrote a PDF on the Mac, then tried to text that Mac path (path-not-allowed).
  assert.ok(flat.includes("A text can attach only a file on your own machine, never a path on a host."));
  assert.ok(flat.includes("To text a file from a host, copy it to your workspace first with `latch file get`, then attach that copy."));
});

test("the prompt directs existing-chat sends to the native tool", () => {
  assert.ok(!prompt.includes("plow_send_message"));
  assert.ok(!prompt.includes("Do not use message"));
  assert.doesNotMatch(prompt, /message\(action="send"\) is for OTHER conversations/i);
  assert.match(prompt, /message\(action="send"\).*current conversation/i);
  assert.doesNotMatch(prompt, /plow_ask_owner|escalation/i);
  assert.match(prompt, /plow_start_thread/);
  assert.doesNotMatch(prompt, /owner-approved follow-up/);
});

test("the prompt treats offered tools as the owner's trust grant", () => {
  assert.match(prompt, /tools are available on a member's turn, the owner trusted/i);
  assert.match(prompt, /plow_reply_to/i);
  assert.match(prompt, /owner.*OK in this thread/i);
  assert.match(prompt, /owner.*yes in the thread.*act there/i);
  assert.match(prompt, /owner answers\s+in their DM[\s\S]*back to the thread/i);
  assert.match(prompt, /do not act on or relay that approval with plow_reply_to/i);
  assert.match(prompt, /requests beyond those guest tools cannot be approved here/i);
  assert.doesNotMatch(prompt, /In the owner's own conversation, act\./);
});

test("the prompt allows saying a bug was reported only with the id report_bug returned", () => {
  const flat = prompt.replace(/\s+/g, " ");
  assert.match(prompt, /asks you to tell\s+your developers about something, call report_bug/i);
  assert.ok(flat.includes("Only say you reported something after that success in this turn: saying you reported it without that call is a false claim."));
  assert.ok(flat.includes("Status duplicate means the same report was already sent earlier: say so, without quoting an id."));
  assert.ok(flat.includes("Delivered false means it was saved but has not reached your developers yet: say that in the one short line, never that you passed it on or reported it."));
  assert.ok(flat.includes("If the call failed, say you could not confirm the report was sent."));
});

// Cedar filed a report and said nothing until asked (#106): the acknowledgement comes first.
test("the prompt has the agent tell the person right after report_bug succeeds, with the id", () => {
  const flat = prompt.replace(/\s+/g, " ");
  assert.ok(flat.includes("As soon as report_bug returns success, tell the person in one short line that you reported it, with the report_id it returned, before anything else in your reply."));
});

// From one Cedar session: it answered the owner's greeting to another group member and asked
// "what seemed off?" before filing when told to report it (plow-agents#83), and asked for a
// contact's number before searching the owner's contacts (plow-agents#82).
for (const [name, expected] of [
  // Silence comes from OpenClaw's room events (boot/config.ts); the prompt says who a group message is for.
  ["the prompt keeps the agent silent in a group when a message is for someone else", "A greeting, a pet name or chat aimed at another person is not for you, even from the owner: post nothing."],
  ["the prompt has the agent answer a group message meant for it", "A message is for you when it uses your name, asks for something you can do, or answers what you just said; answer it, with message(action=\"send\") when your turn says your final text stays private."],
  ["the prompt files report_bug at once when asked, without asking what went wrong", "When the person asks you to report a bug, call report_bug in that turn about what just happened in this conversation, even if they did not say what went wrong; do not ask what they meant first."],
  ["the prompt looks a named person up in the owner's Mac contacts before asking", "look that person up in the owner's contacts on their Mac first (the owners-mac skill) and use what you find. Ask the owner only when no Mac host is reachable or nobody matches"],
] as const) test(name, () => {
  assert.ok(prompt.replace(/\s+/g, " ").includes(expected));
});

// plow-openclaw-agent#126: the agent talked about a group member to the owner, and kept no name for a bare number.
test("in a group the agent speaks to members by name and records a bare number's name once", () => {
  assert.match(prompt, /speak to a member\s+directly by name/);
  assert.match(prompt, /record the name with\s+plow_name_contact, once/);
  assert.match(prompt, /Recording a name is\s+not a reply; still answer in the same turn/);
});

// The agent reaches the owner's machines only through latch: the Mac relay's tools are named nowhere,
// while the image's own Plow tools keep their instructions.
test("the prompt and skills name none of the Mac relay's tools, and keep the native Plow tools", async () => {
  const skills = new URL("../skills/", import.meta.url);
  const texts = [prompt];
  for (const name of await readdir(skills)) texts.push(await readFile(new URL(`${name}/SKILL.md`, skills), "utf8"));
  const relayTools = /plow_(list_skills|read_skill|browser\w*|run_applescript|run_command|read_file|write_file|vault|device_status|history|get_output|get_result)\b/;
  for (const text of texts) assert.doesNotMatch(text, relayTools);
  for (const tool of ["plow_start_thread", "plow_set_thread_trust", "plow_reply_to", "plow_send_email", "plow_name_contact", "report_bug"]) assert.match(prompt, new RegExp(tool));
});
