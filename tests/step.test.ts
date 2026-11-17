import type pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { saveEvent } from "../src/queries.js";
import { Fenced, inputHash, NonDeterminism, step, TransientError, type StepContext } from "../src/step.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

let db: pg.Pool;
let drop: () => Promise<void>;
let taskId: number;
const ctx = (): StepContext => ({ taskId, token: 0, nextStepId: 1, signal: new AbortController().signal, maxSteps: 200, db });
const saved = { inputHash: inputHash("t", {}), attempts: 1, tokens: 5, fencingToken: 0 };

beforeAll(async () => {
  ({ pool: db, drop } = await createTestDb("step"));
  taskId = await seedTask(db, "goal");
  await saveEvent({ ...saved, taskId, stepId: 1, stepType: "t", status: "OK", result: { summary: "s" }, error: null }, db);
  await saveEvent({ ...saved, taskId, stepId: 2, stepType: "t", status: "ERROR", result: undefined, error: "404" }, db);
});
afterAll(() => drop());

it("replays saved steps in call order without calling fn; a saved ERROR comes back as a value", async () => {
  const c = ctx();
  const fn = vi.fn(async () => "fresh");
  expect(await step(c, "t", {}, fn)).toEqual({ ok: true, value: { summary: "s" } });
  expect(await step(c, "t", {}, fn)).toEqual({ ok: false, error: "404" });
  expect(fn).not.toHaveBeenCalled(); // no LLM call, no re-paid work
  expect(c.nextStepId).toBe(3);
});

it("refuses to run a step with no saved result until PHX-019", async () => {
  const c = { ...ctx(), nextStepId: 3 };
  await expect(step(c, "t", {}, async () => "x")).rejects.toThrow(/step 3 .*PHX-019/);
});

it("defines the LLD §4.1 error classes", () => {
  expect(new Fenced("lost my lease")).toMatchObject({ name: "Fenced", message: "lost my lease" });
  expect(new NonDeterminism("x")).toBeInstanceOf(Error);
  expect(new TransientError("429", 2_000).retryAfterMs).toBe(2_000);
});
