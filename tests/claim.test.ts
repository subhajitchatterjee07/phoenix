import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { claim } from "../src/queries.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

let db: pg.Pool;
let drop: () => Promise<void>;
const claimers = (n: number) => Promise.all(Array.from({ length: n }, (_, i) => claim(`worker-${i}`, db))); // truly concurrent: one connection each

beforeAll(async () => ({ pool: db, drop } = await createTestDb("claim")));
afterAll(() => drop());
beforeEach(() => db.query("DELETE FROM tasks"));

it("ten concurrent claimers, one PENDING task: exactly one wins, and the token goes 0 → 1", async () => {
  const id = await seedTask(db, "goal", { sources: ["a"] });
  const won = (await claimers(10)).filter((t) => t !== null);
  expect(won).toEqual([{ taskId: id, token: 1, goal: "goal", input: { sources: ["a"] }, maxSteps: 200 }]);
  const { rows } = await db.query("SELECT status, owner, lease_expires_at > now() AS leased FROM tasks");
  expect(rows).toEqual([{ status: "RUNNING", owner: expect.stringMatching(/^worker-\d$/), leased: true }]);
});

it("five concurrent claimers, three tasks: each task claimed once, two claimers get nothing", async () => {
  const ids = [await seedTask(db, "a"), await seedTask(db, "b"), await seedTask(db, "c")];
  const results = await claimers(5);
  expect(results.filter((t) => t === null)).toHaveLength(2);
  expect(results.flatMap((t) => (t ? [t.taskId] : [])).sort((a, b) => a - b)).toEqual(ids);
});

it("while A's claim is uncommitted (row locked), B skips that task AT ONCE and takes the next", async () => {
  const [first, second] = [await seedTask(db, "a"), await seedTask(db, "b")];
  const a = await db.connect();
  try {
    await a.query("BEGIN");
    expect(await claim("A", a)).toMatchObject({ taskId: first }); // holds the row lock, not committed
    const b = claim("B", db);
    // Without SKIP LOCKED, B would queue behind A's lock instead of moving on.
    expect(await Promise.race([b, sleep(1_000).then(() => "B blocked")])).toMatchObject({ taskId: second });
    await a.query("COMMIT");
    await b;
  } finally {
    a.release();
  }
});

it("a live lease blocks a claim; an expired one is taken over with token +1", async () => {
  const id = await seedTask(db, "goal");
  await claim("A", db);
  expect(await claim("B", db)).toBeNull(); // A's lease is live
  await db.query("UPDATE tasks SET lease_expires_at = now() - interval '1 second'"); // A froze or died
  expect(await claim("B", db)).toMatchObject({ taskId: id, token: 2 });
});

it("claims oldest first, and never a task outside PENDING / RUNNING (design rule 8)", async () => {
  for (const status of ["DONE", "FAILED", "WAITING_APPROVAL"]) {
    await db.query("INSERT INTO tasks (goal, status) VALUES ($1, $1)", [status]);
  }
  const older = await seedTask(db, "older");
  await seedTask(db, "newer");
  expect(await claim("A", db)).toMatchObject({ taskId: older });
  expect(await claim("A", db)).toMatchObject({ goal: "newer" });
  expect(await claim("A", db)).toBeNull();
});
