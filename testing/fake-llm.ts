import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";

// An OpenRouter-shaped fake: point the `openai` client's baseURL here instead of
// https://openrouter.ai/api/v1 and nothing else changes. Latency now (chaos tests need slow
// tasks to kill mid-way); 429 / Retry-After / timeout knobs come in PHX-024.
type ChatBody = { model?: string; messages?: unknown[] };

export function buildFakeLlm({ latencyMs = 0 } = {}) {
  const app = Fastify();
  const calls = new Map<string, number>(); // "task:step" → number of LLM calls

  app.post<{ Body: ChatBody }>("/v1/chat/completions", async (req, reply) => {
    const { model = "fake", messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: { message: "messages is required", type: "invalid_request_error" } });
    }
    const key = `${String(req.headers["x-phoenix-task"] ?? "?")}:${String(req.headers["x-phoenix-step"] ?? "?")}`;
    calls.set(key, (calls.get(key) ?? 0) + 1); // counted on arrival: a caller killed mid-wait still made the call
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));

    // Deterministic: the same messages always get the same answer and token counts.
    const prompt = JSON.stringify(messages);
    const digest = createHash("sha256").update(prompt).digest("hex").slice(0, 12);
    const content = `fake answer ${digest}`;
    const promptTokens = Math.ceil(prompt.length / 4); // ~4 characters per token
    const completionTokens = Math.ceil(content.length / 4);
    return {
      id: `chatcmpl-fake-${digest}`,
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    };
  });

  app.get("/stats", async () => Object.fromEntries(calls));
  app.post("/reset", async () => {
    calls.clear();
    return { ok: true };
  });
  return app;
}

// CLI entry: npm run fake-llm
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_LLM_PORT ?? 9001);
  await buildFakeLlm({ latencyMs: Number(process.env.FAKE_LLM_LATENCY_MS ?? 0) }).listen({ host: "0.0.0.0", port });
  console.log(`fake LLM on http://localhost:${port}/v1`);
}
