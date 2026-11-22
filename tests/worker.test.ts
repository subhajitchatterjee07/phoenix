import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createLlm } from "../src/tools/llm.js";
import { workOnce } from "../src/worker.js";
import { claim } from "../src/queries.js";
import { Fenced, Suspend, type StepContext } from "../src/step.js";
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

it("the workflow's verdict (invalid input: a retry can't fix it) ends the task FAILED with the reason", async () => {
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

it.each([
  ["max_steps = 2", "max_steps = 2", /step limit 2 reached/],
  ["a token budget of 1", "token_budget = 1", /token budget 1 used up/],
])("a task over its limit (%s) ends FAILED with the reason", async (_, limit, reason) => {
  const id = await seedTask(db, "goal", sources);
  await db.query(`UPDATE tasks SET ${limit}`);
  await workOnce(db, run);
  expect(await statusOf(id)).toMatchObject({ status: "FAILED", failure_reason: expect.stringMatching(reason), owner: null });
});

it("DONE is guarded: if another worker took the task meanwhile, mine is not written", async () => {
  const id = await seedTask(db, "goal", sources);
  await workOnce(db, async () => (await db.query("UPDATE tasks SET fencing_token = fencing_token + 1"), "report"));
  expect(await statusOf(id)).toMatchObject({ status: "RUNNING", fencing_token: 2 });
});

it.each([
  ["an unexpected error (a bug, the DB down)", new Error("socket hang up")],
  ["Suspend (paused for approval)", new Suspend("waiting for a decision")],
])("%s is not a failure: the task is left as it is, and another worker can take it once the lease expires", async (_, err) => {
  const id = await seedTask(db, "goal", sources);
  await workOnce(db, async () => { throw err; });
  expect(await statusOf(id)).toMatchObject({ status: "RUNNING", failure_reason: null });
  await db.query("UPDATE tasks SET lease_expires_at = now()"); // fast-forward the 30 s lease
  expect(await claim("another worker", db)).toMatchObject({ taskId: id, token: 2 });
});

it("3 workers drain 10 tasks: every task DONE, every step paid once", async () => {
  const ids = await Promise.all(Array.from({ length: 10 }, () => seedTask(db, "goal", sources)));
  const drain = async () => { while ((await workOnce(db, run)) !== null); };
  await Promise.all([drain(), drain(), drain()]);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM tasks WHERE status = 'DONE' AND fencing_token = 1");
  expect(rows[0].n).toBe(10); // token 1: each task claimed exactly once
  const calls = (await fake.inject({ url: "/stats" })).json() as Record<string, number>;
  expect(Object.keys(calls)).toHaveLength(ids.length * 4);
  expect(new Set(Object.values(calls))).toEqual(new Set([1]));
});
