import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { StepContext } from "../src/step.js";
import { createLlm } from "../src/tools/llm.js";
import { runTask } from "../src/workflows.js";
import { buildFakeLlm } from "../testing/fake-llm.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

const fake = buildFakeLlm();
let llm: ReturnType<typeof createLlm>;
const task = { taskId: 7, goal: "How do the schools price lunch?", input: { sources: ["text A", "text B", "text C"] } };
const stats = async () => (await fake.inject({ url: "/stats" })).json();
let db: pg.Pool;
let drop: () => Promise<void>;
let t: typeof task; // the test's task, saved in a throwaway DB so its steps can be saved too
const ctx = (): StepContext => // what a (new) worker builds: step ids from 1
  ({ taskId: t.taskId, token: 0, nextStepId: 1, signal: new AbortController().signal, maxSteps: 200, db });
const perStep = (counts: number[]) => Object.fromEntries(counts.map((n, i) => [`${t.taskId}:${i + 1}`, n]));

beforeAll(async () => {
  const baseURL = `${await fake.listen({ host: "127.0.0.1", port: 0 })}/v1`;
  llm = createLlm({ baseURL, apiKey: "k", model: "m", timeoutMs: 5_000 });
  ({ pool: db, drop } = await createTestDb("workflows"));
});
afterAll(() => Promise.all([fake.close(), drop()]));
beforeEach(async () => {
  t = { ...task, taskId: await seedTask(db, task.goal, task.input) };
  await fake.inject({ method: "POST", url: "/reset" });
});

it("summarises 3 sources, writes a report: one LLM call per step 1..4", async () => {
  expect(await runTask(ctx(), t, llm)).toMatch(/^fake answer /);
  expect(await stats()).toEqual(perStep([1, 1, 1, 1]));
});

it("FIXED (phase 1 BASELINE PROBLEM): a re-run after a crash pays for nothing, same report", async () => {
  const report = await runTask(ctx(), t, llm);
  expect(await runTask(ctx(), t, llm)).toBe(report); // the restart replays every step
  expect(await stats()).toEqual(perStep([1, 1, 1, 1])); // phase 1: 2, 2, 2, 2
});

it("rejects a task whose input has no sources", async () => {
  await expect(runTask(ctx(), { ...t, input: {} }, llm)).rejects.toThrow(/sources/);
});
