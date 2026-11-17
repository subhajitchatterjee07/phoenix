import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";

// Each run gets a throwaway database, so the test never touches your dev data.
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const dbName = `phoenix_test_${process.pid}`;
const testUrl = () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${dbName}`;
  return url.toString();
};

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
});
afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

it("three migrators starting together apply 001 exactly once", async () => {
  const clients = [1, 2, 3].map(() => new pg.Client({ connectionString: testUrl() }));
  for (const c of clients) await c.connect();
  try {
    const results = await Promise.all(clients.map((c) => migrate(c)));
    expect(results.flat()).toEqual(["001_init.sql"]);

    const { rows } = await clients[0]!.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    expect(rows.map((r) => r.tablename)).toEqual(
      ["decisions", "events", "outbox", "schema_migrations", "tasks"]);
  } finally {
    for (const c of clients) await c.end();
  }
});
