import { expect, it } from "vitest";
import { createTestDb } from "../testing/test-db.js";

it("creates a migrated throwaway database and drops it", async () => {
  const { pool, drop } = await createTestDb("helper");
  const { rows } = await pool.query("SELECT current_database() AS db, to_regclass('tasks') AS t");
  expect(rows[0]).toEqual({ db: expect.stringMatching(/^phoenix_test_helper_/), t: "tasks" });
  await drop();
  const left = await createTestDb("probe"); // the dropped one must be gone
  const { rowCount } = await left.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [rows[0].db]);
  await left.drop();
  expect(rowCount).toBe(0);
});
