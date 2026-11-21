import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";

// An OpenRouter-shaped fake: point the `openai` client's baseURL here instead of
// https://openrouter.ai/api/v1 and nothing else changes. Fault knobs (LLD §10): set at start
// (env / options) or at runtime via POST /faults. Rates are 0..1, rolled per call.
type ChatBody = { model?: string; messages?: unknown[] };
export type Faults = { latencyMs: number; rate429: number; retryAfterS: number | null; rate5xx: number; rateHang: number };
const NO_FAULTS: Faults = { latencyMs: 0, rate429: 0, retryAfterS: null, rate5xx: 0, rateHang: 0 };

export function buildFakeLlm(initial: Partial<Faults> = {}) {
  const app = Fastify();
  let faults: Faults = { ...NO_FAULTS, ...initial };
  const calls = new Map<string, number>(); // "task:step" → number of LLM calls

  app.post<{ Body: ChatBody }>("/v1/chat/completions", async (req, reply) => {
    const { model = "fake", messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: { message: "messages is required", type: "invalid_request_error" } });
    }
    const key = `${String(req.headers["x-phoenix-task"] ?? "?")}:${String(req.headers["x-phoenix-step"] ?? "?")}`;
    calls.set(key, (calls.get(key) ?? 0) + 1); // counted on arrival: a caller killed mid-wait still made the call
    if (faults.latencyMs > 0) await new Promise((r) => setTimeout(r, faults.latencyMs));
    if (Math.random() < faults.rateHang) return new Promise<never>(() => {}); // never answers: caller times out
    if (Math.random() < faults.rate429) {
      if (faults.retryAfterS !== null) reply.header("retry-after", String(faults.retryAfterS));
      return reply.code(429).send({ error: { message: "rate limited (fake)", type: "rate_limit_error" } });
    }
    if (Math.random() < faults.rate5xx) {
      return reply.code(500).send({ error: { message: "upstream failure (fake)", type: "server_error" } });
    }

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
  app.get("/faults", async () => faults);
  app.post<{ Body: Partial<Faults> }>("/faults", async (req) => (faults = { ...faults, ...req.body }));
  app.post("/reset", async () => {
    calls.clear();
    return { ok: true };
  });
  return app;
}

// CLI entry: npm run fake-llm
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_LLM_PORT ?? 9001);
  const num = (name: string) => Number(process.env[name] ?? 0);
  const faults = { latencyMs: num("FAKE_LLM_LATENCY_MS"), rate429: num("FAKE_LLM_429_RATE"), rate5xx: num("FAKE_LLM_5XX_RATE"),
    rateHang: num("FAKE_LLM_HANG_RATE"), retryAfterS: process.env.FAKE_LLM_RETRY_AFTER_S ? num("FAKE_LLM_RETRY_AFTER_S") : null };
  await buildFakeLlm(faults).listen({ host: "0.0.0.0", port });
  console.log(`fake LLM on http://localhost:${port}/v1`);
}
