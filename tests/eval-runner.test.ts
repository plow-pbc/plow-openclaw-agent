import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("evaluation selects a custom matrix and model, preserves repetitions, retries and input hashes", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "plow-eval-"));
  let requests = 0;
  let expectedReasoning = false, expectedMaxTokens = 700;
  let completion = "22";
  let creditLimitAt: number | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only-secret");
    requests++;
    response.setHeader("Content-Type", "application/json");
    if (creditLimitAt !== undefined && requests >= creditLimitAt) { response.writeHead(402).end("{}"); return; }
    assert.equal(input.model, "z-ai/glm-5.2");
    assert.equal(input.reasoning.enabled, expectedReasoning);
    assert.equal(input.max_tokens, expectedMaxTokens);
    if (requests === 1) { response.writeHead(429).end("{}"); return; }
    response.end(JSON.stringify({ choices: [{ message: { content: completion } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const path = join(dir, "cases.json"), output = join(dir, "report.json");
  const matrix = JSON.stringify([{ id: "fixture", category: "onboarding", review: ["Answer the question"], facts: {}, messages: [{ role: "user", content: "14 + 8?" }], contains: ["22"] }]);
  await writeFile(path, matrix);
  async function run(args: string[], model: string | null = "z-ai/glm-5.2") {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../eval/run.ts", import.meta.url)), "--cases", path, ...(model ? ["--model", model] : []), "--output", output, ...args], {
      env: { ...process.env, PLOW_API_BASE: `http://127.0.0.1:${address.port}`, PLOW_AGENT_TOKEN: "fixture-only-secret" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", chunk => { logs += chunk; });
    child.stderr.on("data", chunk => { logs += chunk; });
    return await new Promise<{ code: number | null; logs: string }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => resolve({ code, logs }));
    });
  }
  try {
    const result = await run(["--repeat", "2"]);
    assert.equal(result.code, 0, result.logs);
    const raw = await readFile(output, "utf8"), report = JSON.parse(raw);
    assert.equal(report.expectedResults, 2);
    assert.equal(report.failures, 0);
    assert.deepEqual(report.results.map((value: { repetition: number }) => value.repetition), [1, 2]);
    assert.deepEqual(report.results[0].attempts, ["Model HTTP 429"]);
    assert.equal(report.inputs.casesSha256, createHash("sha256").update(matrix).digest("hex"));
    assert.deepEqual(report.scenarios[0].review, ["Answer the question"]);
    assert.ok(!raw.includes("fixture-only-secret"));
    assert.equal(requests, 3);
    const invalidRepeat = await run(["--repeat", "6"]);
    assert.notEqual(invalidRepeat.code, 0);
    assert.equal(requests, 3, "invalid arguments must not incur a model request");
    const missingValue = await run(["--repeat"]);
    assert.notEqual(missingValue.code, 0);
    assert.match(missingValue.logs, /Missing value for --repeat/);
    assert.equal(requests, 3);
    for (const args of [["--repeats", "2"], ["--repeat", "2", "--repeat", "3"], ["--case", "missing"], ["--reasoning", "maybe"], ["--max-tokens", "0"]]) {
      const invalid = await run(args);
      assert.notEqual(invalid.code, 0, invalid.logs);
      assert.equal(requests, 3, "invalid selection must not incur a model request");
    }
    await writeFile(path, JSON.stringify([JSON.parse(matrix)[0], JSON.parse(matrix)[0]]));
    const duplicate = await run([]);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.logs, /Duplicate evaluation case ID/);
    assert.equal(requests, 3);
    const scenario = JSON.parse(matrix)[0];
    for (const malformed of [
      { ...scenario, contain: ["24"] },
      { ...scenario, maxCharacters: 1 },
      { ...scenario, messages: [{ ...scenario.messages[0], typo: true }] },
    ]) {
      await writeFile(path, JSON.stringify([malformed]));
      const invalid = await run([]);
      assert.notEqual(invalid.code, 0, invalid.logs);
      assert.match(invalid.logs, /unrecognized_keys/);
      assert.equal(requests, 3, "misspelled scenario fields must fail before paid requests");
    }
    await writeFile(path, matrix);
    expectedReasoning = true; expectedMaxTokens = 2000;
    const diagnostic = await run(["--reasoning", "enabled", "--max-tokens", "2000"]);
    assert.equal(diagnostic.code, 0, diagnostic.logs);
    assert.equal(requests, 4);
    const diagnosticReport = JSON.parse(await readFile(output, "utf8"));
    assert.equal(diagnosticReport.modelSettings["plow/z-ai/glm-5.2"].params.extraBody.reasoning.enabled, true);
    assert.equal(diagnosticReport.maxTokens, 2000);
    expectedReasoning = false; expectedMaxTokens = 700;
    const cases = JSON.parse(await readFile(new URL("../eval/cases.json", import.meta.url), "utf8"));
    const uncertainSend = cases.find((scenario: { id: string }) => scenario.id === "uncertain-send");
    assert.ok(uncertainSend);
    await writeFile(path, JSON.stringify([uncertainSend]));
    completion = "Delivery is unconfirmed. Trying again would risk a duplicate send, so I will stop here.";
    const warning = await run([]);
    assert.equal(warning.code, 0, warning.logs);
    completion = "Delivery is unconfirmed. I can try the original account again.";
    const offer = await run([]);
    assert.equal(offer.code, 1, offer.logs);
    assert.equal(JSON.parse(await readFile(output, "utf8")).results[0].checks.doesNotAssert, false);
    await writeFile(path, matrix);
    completion = "22";
    const beforeCredits = requests;
    creditLimitAt = requests + 2;
    const exhausted = await run(["--repeat", "2"], null);
    assert.equal(exhausted.code, 1, exhausted.logs);
    assert.match(exhausted.logs, /Stopped on Model HTTP 402\. Unrun results: 2\/4/);
    assert.equal(requests, beforeCredits + 2, "credit exhaustion stops the entire model/case/repetition matrix without retrying");
    const creditRaw = await readFile(output, "utf8"), creditReport = JSON.parse(creditRaw);
    assert.equal(creditReport.expectedResults, 4);
    assert.equal(creditReport.results.length, 2);
    assert.equal(creditReport.results[0].output, "22", "completed evidence survives the provider failure");
    assert.equal(creditReport.results[0].passed, true);
    assert.equal(creditReport.results[1].error, "Model HTTP 402");
    assert.equal(creditReport.results[1].output, undefined);
    assert.deepEqual(creditReport.results[1].attempts, ["Model HTTP 402"]);
    assert.equal(creditReport.failures, 1);
    assert.deepEqual(creditReport.stopped, { httpStatus: 402, unrunResults: 2 });
    assert.ok(!creditRaw.includes("fixture-only-secret"));
    creditLimitAt = undefined;
    const restored = await run([]);
    assert.equal(restored.code, 0, restored.logs);
    assert.equal(JSON.parse(await readFile(output, "utf8")).stopped, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
