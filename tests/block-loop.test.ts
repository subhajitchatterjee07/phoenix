import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHeartbeat } from "../src/heartbeat.js";
import { claim, loadEvent } from "../src/queries.js";
import { Fenced, step } from "../src/step.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

let db: pg.Pool;
let drop: () => Promise<void>;
beforeAll(async () => ({ pool: db, drop } = await createTestDb("blockloop")));
afterAll(() => drop());

// LLD §4.4: synchronous CPU work in a step blocks the event loop, so the heartbeat can't renew;
// the lease expires and another worker takes the task over. The data must stay safe anyway.
it("a step that blocks the event loop loses its task to a takeover, and its save is rejected", async () => {
  const id = await seedTask(db, "goal");
  const mine = (await claim("blocked worker", db))!;
  await db.query("UPDATE tasks SET lease_expires_at = now() + interval '100 milliseconds'"); // a short lease
  const controller = new AbortController();
  const stop = startHeartbeat(id, mine.token, controller, { db, everyMs: 20, leaseMs: 100 });

  // The other worker is a separate process: it runs while this one is blocked. It keeps
  // trying to claim until the lease has expired, then drops a marker file.
  const marker = join(mkdtempSync(join(tmpdir(), "phx-")), "claimed");
  const url = (db as unknown as { options: { connectionString: string } }).options.connectionString;
  const other = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { writeFileSync } from "node:fs"; import { claim } from "./src/queries.ts";
    while (!(await claim("other worker"))) await new Promise((r) => setTimeout(r, 50));
    writeFileSync(${JSON.stringify(marker)}, ""); process.exit(0);`], { env: { ...process.env, DATABASE_URL: url } });

  const result = step({ taskId: id, token: mine.token, nextStepId: 1, signal: controller.signal, maxSteps: 200, db }, "parse_huge_page", {},
    async () => {
      const deadline = Date.now() + 20_000;
      while (!existsSync(marker) && Date.now() < deadline); // synchronous: no timer, no heartbeat, nothing else runs
      return { value: "computed while blocked" };
    });
  await expect(result).rejects.toThrow(Fenced);
  stop();
  other.kill();
  expect(await loadEvent(id, 1, db)).toBeNull(); // nothing from the blocked worker was saved
  expect((await db.query("SELECT owner, fencing_token FROM tasks")).rows[0]).toEqual({ owner: "other worker", fencing_token: 2 });
});
