import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { cooldownRemainingMs, extendCooldown } from "../src/queries.js";
import { classifyHttp, Fenced, runWithRetries, TransientError } from "../src/step.js";
import { createTestDb } from "../testing/test-db.js";

let db: pg.Pool;
let drop: () => Promise<void>;
beforeAll(async () => ({ pool: db, drop } = await createTestDb("cooldown")));
afterAll(() => drop());
beforeEach(() => db.query("DELETE FROM provider_cooldown"));

it("no cool-down yet: the provider may be called now", async () => {
  expect(await cooldownRemainingMs("llm", db)).toBe(0);
});

it("a 429 from one worker makes everyone wait about that long", async () => {
  await extendCooldown("llm", 5_000, db);
  const ms = await cooldownRemainingMs("llm", db);
  expect(ms).toBeGreaterThan(4_000);
  expect(ms).toBeLessThanOrEqual(5_000);
});

it("GREATEST: a later, shorter wait (another worker's 429) never moves the cool-down back", async () => {
  await extendCooldown("llm", 5_000, db);
  await extendCooldown("llm", 1_000, db);
  expect(await cooldownRemainingMs("llm", db)).toBeGreaterThan(4_000);
});

it("an expired cool-down reads as 0, and each provider has its own", async () => {
  await extendCooldown("llm", -1_000, db); // already over
  await extendCooldown("other", 5_000, db);
  expect(await cooldownRemainingMs("llm", db)).toBe(0);
  expect(await cooldownRemainingMs("other", db)).toBeGreaterThan(4_000);
});

const fast = { maxAttempts: 5, baseMs: 200, capMs: 1_000 };
const llm = () => ({ provider: "llm", db });
const rows = async () => (await db.query("SELECT count(*)::int AS n FROM provider_cooldown")).rows[0].n;

it("another worker's cool-down makes my next attempt wait for it first", async () => {
  await extendCooldown("llm", 300, db); // worker A just got a 429
  const t0 = Date.now();
  let calledAfter = 0;
  await runWithRetries(async () => (calledAfter = Date.now() - t0), new AbortController().signal, fast, llm());
  expect(calledAfter).toBeGreaterThanOrEqual(250);
});

it.each([
  ["a 429", classifyHttp(429, "rate limited", "0.1"), 1],
  ["a 503", classifyHttp(503, "overloaded"), 1],
  ["a timeout (no status: maybe just my network)", new TransientError("timeout"), 0],
])("%s: the shared cool-down is pushed forward only for overload (429 / 5xx)", async (_, err, expected) => {
  let calls = 0;
  await runWithRetries(async () => { if (++calls === 1) throw err; return "ok"; }, new AbortController().signal, fast, llm());
  expect(await rows()).toBe(expected);
});

it("a worker fenced while waiting out the cool-down stops at once (Fenced), without calling", async () => {
  await extendCooldown("llm", 10_000, db);
  const controller = new AbortController();
  const run = runWithRetries(async () => "called", controller.signal, fast, llm());
  setTimeout(() => controller.abort(), 50);
  await expect(run).rejects.toThrow(Fenced);
});
