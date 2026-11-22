import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { cooldownRemainingMs, extendCooldown } from "../src/queries.js";
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
