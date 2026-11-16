import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withTransaction } from "../src/db.js";

it("reaches the Postgres 16 at DATABASE_URL", async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ v: string }>("SELECT current_setting('server_version') AS v");
    expect(rows[0]?.v).toMatch(/^16\./);
  } finally {
    await client.end();
  }
});

describe("withTransaction", () => {
  // A real table: TEMP tables belong to one connection, but the pool hands out several.
  const table = `db_test_${process.pid}`;
  const count = async (id: number) =>
    (await pool.query<{ n: number }>(`SELECT count(*)::bigint AS n FROM ${table} WHERE id = $1`, [id])).rows[0]?.n;

  beforeAll(() => pool.query(`CREATE TABLE ${table} (id BIGINT)`));
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  });

  it("commits and returns fn's value", async () => {
    const value = await withTransaction(async (c) => {
      await c.query(`INSERT INTO ${table} VALUES (1)`);
      return "ok";
    });
    expect(value).toBe("ok");
    expect(await count(1)).toBe(1);
  });

  it("rolls back and rethrows the same error, and releases the client", async () => {
    const boom = new Error("boom");
    await expect(withTransaction(async (c) => {
      await c.query(`INSERT INTO ${table} VALUES (2)`);
      throw boom;
    })).rejects.toBe(boom);
    // Without ROLLBACK the client returns to the pool mid-transaction; the pool reuses it
    // for this count, which then sees the "rolled back" row. That is the bug this guards.
    expect(await count(2)).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount); // nobody is still holding a client
  });

  it("returns BIGINT as a number and refuses values past 2^53", async () => {
    const { rows } = await pool.query<{ n: unknown }>("SELECT 9007199254740991::bigint AS n");
    expect(rows[0]?.n).toBe(Number.MAX_SAFE_INTEGER);
    await expect(pool.query("SELECT 9007199254740993::bigint AS n")).rejects.toThrow(RangeError);
  });
});
