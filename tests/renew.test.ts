import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { claim, renew, type ClaimedTask } from "../src/queries.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

let db: pg.Pool;
let drop: () => Promise<void>;
let task: ClaimedTask;
const lease = async () => (await db.query("SELECT lease_expires_at FROM tasks")).rows[0].lease_expires_at as Date;

beforeAll(async () => ({ pool: db, drop } = await createTestDb("renew")));
afterAll(() => drop());
beforeEach(async () => {
  await db.query("DELETE FROM tasks");
  await seedTask(db, "goal");
  task = (await claim("me", db))!;
});

it("extends my lease to now() + LEASE_SECONDS", async () => {
  await db.query("UPDATE tasks SET lease_expires_at = now() + interval '1 second'"); // almost expired
  expect(await renew(task.taskId, task.token, db)).toBe(true);
  expect((await lease()).getTime() - Date.now()).toBeGreaterThan(25_000);
});

it.each([
  ["another worker claimed it (my token is stale)", "fencing_token = fencing_token + 1"],
  ["the task left RUNNING", "status = 'DONE'"],
])("returns false, changing nothing, when %s", async (_, change) => {
  await db.query(`UPDATE tasks SET ${change}`);
  const before = await lease();
  expect(await renew(task.taskId, task.token, db)).toBe(false);
  expect(await lease()).toEqual(before);
});
