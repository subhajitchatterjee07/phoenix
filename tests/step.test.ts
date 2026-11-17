import type pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadEvent, saveEvent } from "../src/queries.js";
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
  const fn = vi.fn(async () => ({ value: "fresh" }));
  expect(await step(c, "t", {}, fn)).toEqual({ ok: true, value: { summary: "s" } });
  expect(await step(c, "t", {}, fn)).toEqual({ ok: false, error: "404" });
  expect(fn).not.toHaveBeenCalled(); // no LLM call, no re-paid work
  expect(c.nextStepId).toBe(3);
});

it("runs a new step once, saves its value and tokens, and replays it without calling fn", async () => {
  const fn = vi.fn(async (a: { n: number }) => ({ value: { doubled: a.n * 2 }, tokens: 7 }));
  expect(await step({ ...ctx(), nextStepId: 3 }, "double", { n: 21 }, fn)).toEqual({ ok: true, value: { doubled: 42 } });
  expect(await step({ ...ctx(), nextStepId: 3 }, "double", { n: 21 }, fn)).toEqual({ ok: true, value: { doubled: 42 } });
  expect(fn).toHaveBeenCalledTimes(1); // the second call (a "restart") was a lookup
  expect(await loadEvent(taskId, 3, db)).toMatchObject({ stepType: "double", tokens: 7, attempts: 1 });
});

it("throws NonDeterminism when a saved step is replayed with different args, and runs nothing", async () => {
  const fn = vi.fn(async () => ({ value: "x" }));
  await expect(step(ctx(), "t", { prompt: "fixed typo" }, fn)).rejects.toBeInstanceOf(NonDeterminism);
  expect(fn).not.toHaveBeenCalled();
});

it("a fenced worker (aborted signal) starts no new step", async () => {
  const controller = new AbortController();
  controller.abort();
  const fn = vi.fn(async () => ({ value: 1 }));
  await expect(step({ ...ctx(), nextStepId: 10, signal: controller.signal }, "t", {}, fn)).rejects.toBeInstanceOf(Fenced);
  expect(fn).not.toHaveBeenCalled();
});

it("if fn throws, nothing is saved and the error reaches the caller", async () => {
  await expect(step({ ...ctx(), nextStepId: 11 }, "t", {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await loadEvent(taskId, 11, db)).toBeNull();
});

it("rejects a value that replay could not return identically", async () => {
  await expect(step({ ...ctx(), nextStepId: 12 }, "t", {}, async () => ({ value: new Date(0) }))).rejects.toThrow(TypeError);
});

it("defines the LLD §4.1 error classes", () => {
  expect(new Fenced("lost my lease")).toMatchObject({ name: "Fenced", message: "lost my lease" });
  expect(new NonDeterminism("x")).toBeInstanceOf(Error);
  expect(new TransientError("429", 2_000).retryAfterMs).toBe(2_000);
});
