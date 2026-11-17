import { afterAll, beforeAll, expect, it } from "vitest";
import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { seedTask } from "../testing/seed.js";

beforeAll(async () => {
  const client = await pool.connect();
  try {
    await migrate(client); // CI's database starts empty
  } finally {
    client.release();
  }
});
afterAll(() => pool.end());

it("inserts one PENDING task with goal, input and max_steps, and returns its numeric id", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); // rolled back below: never leaves a real task for a worker
    const id = await seedTask(client, "Summarise pricing", { schools: ["A", "B"] });
    const { rows } = await client.query("SELECT * FROM tasks WHERE task_id = $1", [id]);
    expect(typeof id).toBe("number");
    expect(rows[0]).toMatchObject({
      goal: "Summarise pricing", input: { schools: ["A", "B"] }, status: "PENDING",
      max_steps: 200, owner: null, fencing_token: 0,
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
