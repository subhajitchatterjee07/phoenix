import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startHeartbeat } from "../src/heartbeat.js";
import { claim, type ClaimedTask } from "../src/queries.js";
import { Fenced } from "../src/step.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

let db: pg.Pool;
let drop: () => Promise<void>;
let task: ClaimedTask;
let stop = () => {};
const fast = { everyMs: 30, leaseMs: 150 };
// A database whose renew number n fails when failOn(n), and works otherwise.
const flaky = (failOn: (n: number) => boolean) => {
  let calls = 0;
  return { calls: () => calls, query: ((...a: Parameters<pg.Pool["query"]>) =>
    failOn(++calls) ? Promise.reject(new Error("connection reset")) : db.query(...a)) as pg.Pool["query"] };
};

beforeAll(async () => ({ pool: db, drop } = await createTestDb("heartbeat")));
afterAll(() => drop());
afterEach(() => stop());
beforeEach(async () => {
  await db.query("DELETE FROM tasks");
  await seedTask(db, "goal");
  task = (await claim("me", db))!;
});

it("renew hits 0 rows (another worker claimed it): the running task is aborted with Fenced", async () => {
  const controller = new AbortController();
  stop = startHeartbeat(task.taskId, task.token, controller, { db, ...fast });
  await db.query("UPDATE tasks SET fencing_token = fencing_token + 1");
  await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
  expect(controller.signal.reason).toBeInstanceOf(Fenced);
});

it("one failed renew (a blip) after a long healthy run does not abort; the next beat renews again", async () => {
  const controller = new AbortController();
  const blip = flaky((n) => n === 8); // 7 good renews ≈ 210 ms > the 150 ms lease, then one blip
  stop = startHeartbeat(task.taskId, task.token, controller, { db: blip, ...fast });
  await vi.waitFor(() => expect(blip.calls()).toBeGreaterThanOrEqual(10));
  expect(controller.signal.aborted).toBe(false);
});

it("no successful renew for a full lease aborts, even without a 0-row answer (D-31)", async () => {
  const controller = new AbortController();
  stop = startHeartbeat(task.taskId, task.token, controller, { db: flaky(() => true), ...fast });
  await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
  expect(String(controller.signal.reason)).toMatch(/no renew for 150 ms/);
});

it("stop() during an in-flight renew: no renew is scheduled after it", async () => {
  let calls = 0;
  let release = () => {};
  const gated = { query: ((...a: Parameters<pg.Pool["query"]>) => (++calls, new Promise((r) => (release = () => r(db.query(...a)))))) as pg.Pool["query"] };
  stop = startHeartbeat(task.taskId, task.token, new AbortController(), { db: gated, ...fast });
  await vi.waitFor(() => expect(calls).toBe(1)); // renew 1 is in flight
  stop(); // nothing to clearTimeout yet: only the stopped flag can prevent renew 2
  release();
  await sleep(100);
  expect(calls).toBe(1);
});
