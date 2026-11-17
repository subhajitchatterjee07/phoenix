import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadEvent, saveEvent, type NewEvent } from "../src/queries.js";
import { createTestDb } from "../testing/test-db.js";
import { seedTask } from "../testing/seed.js";

let db: pg.Pool;
let drop: () => Promise<void>;
let taskId: number;
const tokensUsed = async () =>
  (await db.query("SELECT tokens_used FROM tasks WHERE task_id = $1", [taskId])).rows[0].tokens_used;
const row = async (stepId: number) =>
  (await db.query("SELECT status, result_inline, error, tokens FROM events WHERE task_id = $1 AND step_id = $2", [taskId, stepId])).rows[0];
const event = (stepId: number, over: Partial<NewEvent> = {}): NewEvent => ({
  taskId, stepId, stepType: "llm_summarize", inputHash: "h".repeat(64), status: "OK",
  result: { summary: "s" }, error: null, attempts: 1, tokens: 10, fencingToken: 0, ...over,
});

beforeAll(async () => {
  ({ pool: db, drop } = await createTestDb("queries"));
  taskId = await seedTask(db, "goal");
});
afterAll(() => drop());

it("saves a step's result as JSON and adds its tokens to the task", async () => {
  await saveEvent(event(1, { result: { summary: "s", items: ["a", "b"] } }), db);
  await saveEvent(event(2, { result: ["x", "y"] }), db); // a top-level array must stay JSON
  expect(await row(1)).toEqual({ status: "OK", result_inline: { summary: "s", items: ["a", "b"] }, error: null, tokens: 10 });
  expect((await row(2)).result_inline).toEqual(["x", "y"]);
  expect(await tokensUsed()).toBe(20);
});

it("rejects a second save of the same step, and rolls its token update back", async () => {
  const before = await tokensUsed();
  await expect(saveEvent(event(1, { tokens: 500 }), db)).rejects.toMatchObject({ code: "23505" }); // unique_violation
  expect(await tokensUsed()).toBe(before);
});

it("refuses a result over INLINE_RESULT_MAX_BYTES with a clear error, saving nothing", async () => {
  await expect(saveEvent(event(4, { result: "x".repeat(70_000) }), db)).rejects.toThrow(/INLINE_RESULT_MAX_BYTES.*PHX-064/);
  expect(await row(4)).toBeUndefined();
});

it("loadEvent returns exactly what saveEvent stored", async () => {
  expect(await loadEvent(taskId, 1, db)).toEqual({
    stepType: "llm_summarize", inputHash: "h".repeat(64), status: "OK",
    result: { summary: "s", items: ["a", "b"] }, error: null, attempts: 1, tokens: 10,
  });
  expect((await loadEvent(taskId, 2, db))?.result).toEqual(["x", "y"]);
});

it("loadEvent returns null for a step that never finished", async () => {
  expect(await loadEvent(taskId, 99, db)).toBeNull();
});

it("loadEvent returns a recorded ERROR as a value: no result, the error text", async () => {
  await saveEvent(event(3, { status: "ERROR", result: undefined, error: "404 Not Found", attempts: 5 }), db);
  expect(await loadEvent(taskId, 3, db)).toMatchObject({ status: "ERROR", result: null, error: "404 Not Found", attempts: 5 });
});
