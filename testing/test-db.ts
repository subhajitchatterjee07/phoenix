import pg from "pg";
import { migrate } from "../src/migrate.js";

/**
 * A fresh, migrated database for one test file, so tests never touch your dev data and a
 * real worker can never pick up a test task. Call drop() in afterAll.
 */
export async function createTestDb(name: string): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  const dbName = `phoenix_test_${name}_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  await migrate(client).finally(() => client.release());

  const drop = async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  };
  return { pool, drop };
}
