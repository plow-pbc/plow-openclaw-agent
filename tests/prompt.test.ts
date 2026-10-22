import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { renderPrompt } from "../boot/prompt.ts";

const prompt = await readFile(new URL("../prompt/AGENTS.md", import.meta.url), "utf8");

test("no Mac still renders the default thread trust instruction", async () => {
  assert.match(await renderPrompt(prompt, null, "test-token"), /ask the owner whether the group should have full trust/i);
});

for (const [mode, expected] of [
  ["ask", /ask the owner whether the group should have full trust/i],
  ["trusted", /create groups with trusted: true/i],
  ["untrusted", /create groups with trusted: false/i],
] as const) test(`thread trust mode ${mode} renders its instruction`, async () => {
  const rendered = await renderPrompt(prompt, null, "test-token", mode);
  assert.match(rendered, expected);
  if (mode !== "ask") assert.doesNotMatch(rendered, /ask the owner whether the group should have full trust/i);
});

// plow#2366: narration texted to a phone is noise and costs tokens.
test("the prompt asks for results, not a running narration", () => {
  assert.match(prompt, /Text results, not a running narration of the work\./);
  assert.match(prompt, /no progress notes between steps/);
});

test("invalid thread trust mode fails at boot", async () => {
  await assert.rejects(renderPrompt(prompt, null, "test-token", "unknown"), /PLOW_THREAD_TRUST/);
});

test("dashboard address comes from agent identity, including absence", async () => {
  const base = await renderPrompt(prompt, null, "test-token", "ask", null);
  assert.equal(await renderPrompt(prompt, null, "test-token", "ask", "https://dashboard.example/agent"),
    base.replace("\nYou have no dashboard. Say so when asked for its URL; never guess one.\n",
      "\nYour dashboard is https://dashboard.example/agent. Give that exact address when asked; never guess a dashboard URL.\n"));
  assert.match(base, /You have no dashboard. Say so when asked for its URL/);
});

test("the prompt puts Latch's tools and the Mac's skills before improvising", () => {
  const flat = prompt.replace(/\s+/g, " ");
  assert.ok(flat.includes("Before any task on the owner's Mac, use Latch's own tools and the skill that covers the task first (plow_list_skills, then plow_read_skill)."));
  assert.ok(flat.includes("For web browsing that is plow_browser as the camoufox-browsing skill describes, with its documented fallbacks, such as its Safari recipe"));
  assert.ok(flat.includes("Improvise (capture the screen, script another app's interface) only when no Latch tool can do the job, and then tell the person what you are doing and why"));
});

for (const format of ["json", "sse", "oversized", "missing", "invalid", "unavailable", "redirect"]) {
  test(`Latch initialize instructions: ${format}`, async () => {
    let requests = 0;
    const server = createServer(async (request, response) => {
      requests++;
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, "Bearer test-token");
      assert.equal(request.headers.accept, "application/json, text/event-stream");
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body);
      assert.equal(rpc.method, "initialize");
      assert.equal(rpc.params.protocolVersion, "2025-06-18");
      const instructions = format === "oversized" ? "A".repeat(8_000) + "OMIT"
        : "Use plow_list_skills to discover the owner's Mac skills.";
      const result = format === "missing" ? {} : { instructions: format === "invalid" ? {} : instructions };
      const payload = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
      response.writeHead(format === "unavailable" ? 503 : format === "redirect" ? 307 : 200, {
        "Content-Type": format === "sse" ? "text/event-stream" : "application/json",
        ...(format === "redirect" ? { Location: "/other" } : {}),
      });
      response.end(format === "sse" ? `event: message\ndata: ${payload}\n\n` : payload);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const rendered = await renderPrompt(prompt, `http://127.0.0.1:${address.port}`, "test-token", "ask");
      const expectedInstructions = format === "oversized" ? "A".repeat(8_000)
        : "Use plow_list_skills to discover the owner's Mac skills.";
      const base = await renderPrompt(prompt, null, "test-token", "ask");
      assert.equal(rendered, ["json", "sse", "oversized"].includes(format)
        ? `${base}\nInstructions from your owner's Mac through Latch (up to 8,000 characters):\n\n\`\`\`text\n${expectedInstructions}\n\`\`\`\n`
        : base);
      assert.ok(rendered.length <= 20_000, "workspace instructions fit the per-file context cap");
      assert.equal(requests, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

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
  assert.match(prompt, /asks you to tell\s+your developers about something, call report_bug/i);
  assert.match(prompt, /Only say you reported something after report_bug has returned success in this\s+turn, and give the person the report_id it returned/);
  assert.match(prompt, /Status duplicate means the same report was\s+already sent earlier: say so, without quoting an id/);
  assert.match(prompt, /If the call failed, say\s+you could not confirm the report was sent/);
});
