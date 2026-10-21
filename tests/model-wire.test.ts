import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { renderConfig } from "../boot/config.ts";
import { runtimeFunction } from "./runtime-function.ts";

test("GLM opts out of reasoning on the wire without changing Sonnet or model selection", async () => {
  const applyExtraParams = await runtimeFunction("extra-params-", "applyExtraParamsToAgent");
  const streamSimple = await runtimeFunction("stream-", "streamSimple");
  const buildAllowedModelSet = await runtimeFunction("model-selection-shared-", "buildAllowedModelSet");
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (choices: unknown[], usage?: object) => `data: ${JSON.stringify({
      id: "wire-probe", object: "chat.completion.chunk", model: body.model, choices, usage,
    })}\n\n`;
    res.write(frame([{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }]));
    res.write(frame([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = renderConfig({ agent: { name: "Probe" }, line: { uid: "ln_probe" }, chats: [] }, `http://127.0.0.1:${address.port}`);
    assert.equal(buildAllowedModelSet({ cfg: config, catalog: [], defaultProvider: "plow" }).allowAny, true);
    const provider = config.models.providers.plow;
    for (const definition of provider.models) {
      const model = { ...definition, provider: "plow", api: provider.api, baseUrl: provider.baseUrl,
        request: provider.request, reasoning: false, maxTokens: 256, cost: { ...definition.cost, cacheRead: 0, cacheWrite: 0 } };
      const agent = { streamFn: streamSimple };
      applyExtraParams(agent, config, "plow", model.id, undefined, "off", "main", undefined, model);
      const result = await agent.streamFn(model, { messages: [{ role: "user", content: "Say OK", timestamp: Date.now() }] },
        { apiKey: "local-wire-probe", maxTokens: 16 }).result();
      assert.notEqual(result.stopReason, "error", result.errorMessage);
      assert.equal(result.content.find((block: { type: string }) => block.type === "text")?.text, "OK");
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].reasoning, { enabled: false });
    assert.equal(requests[1].reasoning, undefined);
    assert.equal(requests[1].reasoning_effort, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
