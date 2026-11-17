import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createLlm } from "../src/tools/llm.js";
import { Fenced } from "../src/step.js";
import { workOnce } from "../src/worker.js";
import { runTaskPhase1, type Task } from "../src/workflows.js";
import { buildFakeLlm } from "../testing/fake-llm.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";
let db: pg.Pool;
let drop: () => Promise<void>;
let run: (task: Task) => ReturnType<typeof runTaskPhase1>;
const fake = buildFakeLlm();
const sources = { sources: ["a", "b", "c"] };
const statusOf = async (id: number) => (await db.query("SELECT * FROM tasks WHERE task_id = $1", [id])).rows[0];

beforeAll(async () => {
  ({ pool: db, drop } = await createTestDb("worker"));
  const llm = createLlm({ baseURL: `${await fake.listen({ port: 0 })}/v1`, apiKey: "k", model: "m", timeoutMs: 5_000 });
  run = (task) => runTaskPhase1(task, llm);
});
afterAll(() => Promise.all([fake.close(), drop()]));
beforeEach(async () => {
  await db.query("DELETE FROM tasks");
  await fake.inject({ method: "POST", url: "/reset" });
});

it("takes a seeded task to DONE, then finds nothing left", async () => {
  const id = await seedTask(db, "goal", sources);
  expect(await workOnce(db, run)).toBe(id);
  expect(await statusOf(id)).toMatchObject({ status: "DONE" });
  expect(await workOnce(db, run)).toBeNull();
});

it("marks the task FAILED with the reason when the workflow throws (phase 1 only)", async () => {
  const id = await seedTask(db, "goal", { sources: [] });
  await workOnce(db, run);
  expect(await statusOf(id)).toMatchObject({ status: "FAILED", failure_reason: expect.stringMatching(/sources/) });
});

it("drops a task on Fenced: no FAILED, status left as the other worker sets it (design rule 5)", async () => {
  const id = await seedTask(db, "goal", sources);
  expect(await workOnce(db, async () => { throw new Fenced("another worker already saved step 1"); })).toBe(id);
  expect(await statusOf(id)).toMatchObject({ status: "RUNNING", failure_reason: null });
});

it("BASELINE PROBLEM: two workers polling together both run the same task", async () => {
  const id = await seedTask(db, "goal", sources);
  // The SELECT→UPDATE gap is ~1 ms (collisions are luck); widen it to 50 ms so they always happen.
  const slowDb = { query: async (text: string, params?: unknown[]) => {
    if (text.includes("'RUNNING'")) await new Promise((r) => setTimeout(r, 50));
    return db.query(text, params);
  } } as Pick<pg.Pool, "query">;
  expect(await Promise.all([workOnce(slowDb, run), workOnce(slowDb, run)])).toEqual([id, id]);
  // Every LLM call paid twice. The atomic claim (PHX-036) must make one worker get null.
  expect(Object.values((await fake.inject({ url: "/stats" })).json())).toEqual([2, 2, 2, 2]);
});
