import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createLlm } from "../src/tools/llm.js";
import { workOnce } from "../src/worker.js";
import { Fenced, type StepContext } from "../src/step.js";
import { runTask, type Task } from "../src/workflows.js";
import { buildFakeLlm } from "../testing/fake-llm.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";
let db: pg.Pool;
let drop: () => Promise<void>;
let run: (ctx: StepContext, task: Task) => Promise<string>;
const fake = buildFakeLlm();
const sources = { sources: ["a", "b", "c"] };
const statusOf = async (id: number) => (await db.query("SELECT * FROM tasks WHERE task_id = $1", [id])).rows[0];

beforeAll(async () => {
  ({ pool: db, drop } = await createTestDb("worker"));
  const llm = createLlm({ baseURL: `${await fake.listen({ port: 0 })}/v1`, apiKey: "k", model: "m", timeoutMs: 5_000 });
  run = (ctx, task) => runTask({ ...ctx, db }, task, llm); // steps save into the test DB
});
afterAll(() => Promise.all([fake.close(), drop()]));
beforeEach(async () => {
  await db.query("DELETE FROM events; DELETE FROM tasks");
  await fake.inject({ method: "POST", url: "/reset" });
});

it("takes a seeded task to DONE, then finds nothing left", async () => {
  const id = await seedTask(db, "goal", sources);
  expect(await workOnce(db, run)).toBe(id);
  expect(await statusOf(id)).toMatchObject({ status: "DONE", tokens_used: expect.any(Number) });
  const { rows } = await db.query("SELECT sum(tokens)::bigint AS s FROM events WHERE task_id = $1", [id]);
  expect((await statusOf(id)).tokens_used).toBe(rows[0].s); // counted once, by the steps
  expect(await workOnce(db, run)).toBeNull();
});

it("marks the task FAILED with the reason when the workflow throws (until PHX-040)", async () => {
  const id = await seedTask(db, "goal", { sources: [] });
  await workOnce(db, run);
  expect(await statusOf(id)).toMatchObject({ status: "FAILED", failure_reason: expect.stringMatching(/sources/) });
});

it("drops a task on Fenced: no FAILED, status left as the other worker sets it (design rule 5)", async () => {
  const id = await seedTask(db, "goal", sources);
  expect(await workOnce(db, async () => { throw new Fenced("another worker already saved step 1"); })).toBe(id);
  expect(await statusOf(id)).toMatchObject({ status: "RUNNING", failure_reason: null });
});

it("two workers start together on one task: one claims it, the other finds nothing; each step paid once", async () => {
  const id = await seedTask(db, "goal", sources);
  expect((await Promise.all([workOnce(db, run), workOnce(db, run)])).sort()).toEqual([id, null]);
  expect((await fake.inject({ url: "/stats" })).json()).toEqual(Object.fromEntries([1, 2, 3, 4].map((s) => [`${id}:${s}`, 1])));
  expect(await statusOf(id)).toMatchObject({ status: "DONE", owner: null, lease_expires_at: null, fencing_token: 1 });
});
