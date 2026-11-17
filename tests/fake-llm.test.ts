import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { buildFakeLlm } from "../testing/fake-llm.js";

// Talks to the fake through the official `openai` client, exactly as Phoenix will talk
// to OpenRouter. If this passes, swapping to a real model is a config change.
const app = buildFakeLlm();
let llm: OpenAI;
const messages = [{ role: "user" as const, content: "Summarise pricing" }];
const forStep = (task: number, step: number) => ({
  headers: { "X-Phoenix-Task": String(task), "X-Phoenix-Step": String(step) },
});

beforeAll(async () => {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  llm = new OpenAI({ baseURL: `${address}/v1`, apiKey: "not-needed" });
});
afterAll(() => app.close());
beforeEach(() => app.inject({ method: "POST", url: "/reset" }));

it("answers like OpenRouter: same prompt, same answer; model echoed; usage filled", async () => {
  const a = await llm.chat.completions.create({ model: "deepseek/deepseek-chat", messages }, forStep(42, 3));
  const b = await llm.chat.completions.create({ model: "deepseek/deepseek-chat", messages }, forStep(42, 3));
  expect(a.model).toBe("deepseek/deepseek-chat");
  expect(a.choices[0]?.message.content).toMatch(/^fake answer [0-9a-f]{12}$/);
  expect(b.choices[0]?.message.content).toBe(a.choices[0]?.message.content);
  expect(a.usage?.total_tokens).toBeGreaterThan(0);
});

it("counts calls per (task, step) and resets", async () => {
  await llm.chat.completions.create({ model: "m", messages }, forStep(42, 3));
  await llm.chat.completions.create({ model: "m", messages }, forStep(42, 3));
  await llm.chat.completions.create({ model: "m", messages }, forStep(42, 4));
  expect((await app.inject({ url: "/stats" })).json()).toEqual({ "42:3": 2, "42:4": 1 });
  await app.inject({ method: "POST", url: "/reset" });
  expect((await app.inject({ url: "/stats" })).json()).toEqual({});
});

it("rejects a request without messages with a 400, like the real API", async () => {
  await expect(llm.chat.completions.create({ model: "m", messages: [] })).rejects.toMatchObject({ status: 400 });
});

it("latency: waits before answering, but counts the call as soon as it arrives", async () => {
  const slow = buildFakeLlm({ latencyMs: 300 });
  const client = new OpenAI({ baseURL: `${await slow.listen({ host: "127.0.0.1", port: 0 })}/v1`, apiKey: "k" });
  const started = Date.now();
  const pending = client.chat.completions.create({ model: "m", messages }, forStep(9, 1));
  await new Promise((r) => setTimeout(r, 100));
  expect((await slow.inject({ url: "/stats" })).json()).toEqual({ "9:1": 1 }); // counted before the answer
  await pending;
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  await slow.close();
});
