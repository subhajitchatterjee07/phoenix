import pg from "pg";
import { expect, it } from "vitest";

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
