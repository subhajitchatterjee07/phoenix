import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createLlm } from "../src/tools/llm.js";
import { runTask } from "../src/workflows.js";
import { buildFakeLlm } from "../testing/fake-llm.js";

const fake = buildFakeLlm();
let llm: ReturnType<typeof createLlm>;
const task = { taskId: 7, goal: "How do the schools price lunch?", input: { sources: ["text A", "text B", "text C"] } };
const stats = async () => (await fake.inject({ url: "/stats" })).json();

beforeAll(async () => {
  const baseURL = `${await fake.listen({ host: "127.0.0.1", port: 0 })}/v1`;
  llm = createLlm({ baseURL, apiKey: "k", model: "m", timeoutMs: 5_000 });
});
afterAll(() => fake.close());
beforeEach(() => fake.inject({ method: "POST", url: "/reset" }));

it("fetches, summarises 3 sources, writes a report: one LLM call per step 2..5", async () => {
  const result = await runTask(task, llm);
  expect(result.report).toMatch(/^fake answer /);
  expect(result.tokens).toBeGreaterThan(0);
  expect(await stats()).toEqual({ "7:2": 1, "7:3": 1, "7:4": 1, "7:5": 1 });
});

it("is deterministic: the same task gives the same report", async () => {
  expect((await runTask(task, llm)).report).toBe((await runTask(task, llm)).report);
});

it("BASELINE PROBLEM: running the task again (as after a crash) pays for every LLM call again", async () => {
  await runTask(task, llm);
  await runTask(task, llm); // phase 2 must turn these second calls into saved-result lookups
  expect(await stats()).toEqual({ "7:2": 2, "7:3": 2, "7:4": 2, "7:5": 2 });
});

it("rejects a task whose input has no sources", async () => {
  await expect(runTask({ ...task, input: {} }, llm)).rejects.toThrow(/sources/);
});
