import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type pg from "pg";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";

/**
 * DEV/TEST ONLY: inserts a PENDING task straight into Postgres, bypassing the API
 * (the product's only task writer, HLD §4). Approved in the design notes, PHX-012.
 */
export async function seedTask(db: pg.ClientBase | pg.Pool, goal: string, input: unknown = {}): Promise<number> {
  const { rows } = await db.query<{ task_id: number }>(
    "INSERT INTO tasks (goal, input, max_steps) VALUES ($1, $2, $3) RETURNING task_id",
    [goal, JSON.stringify(input), config.DEFAULT_MAX_STEPS],
  );
  const taskId = rows[0]?.task_id;
  if (taskId === undefined) throw new Error("INSERT returned no task_id");
  return taskId;
}

// CLI entry: npm run seed -- "Summarise pricing for Acme" [--input '{"schools":["A","B"]}']
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { input: { type: "string" } } });
  const goal = positionals.join(" ").trim();
  if (!goal) {
    console.error('usage: npm run seed -- "<goal>" [--input \'<json>\']');
    process.exit(1);
  }
  try {
    console.log(await seedTask(pool, goal, values.input ? JSON.parse(values.input) : {}));
  } finally {
    await pool.end();
  }
}
