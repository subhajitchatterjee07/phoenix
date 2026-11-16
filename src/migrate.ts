import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "migrations");
const LOCK_KEY = 7_420_001; // any fixed number; every migrator must use the same one

/** Applies new migrations/*.sql files in name order. Returns the names it applied. */
export async function migrate(client: pg.ClientBase): Promise<string[]> {
  // Session-level lock: concurrent migrators queue here. Released on unlock or disconnect.
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    const applied: string[] = [];
    for (const file of files.filter((f) => !done.has(f))) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      // The migration and its bookkeeping row commit together, or not at all.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

// CLI entry: npm run db:migrate
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const applied = await migrate(client);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema up to date");
  } finally {
    await client.end();
  }
}
