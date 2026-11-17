import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";
import { Fenced } from "./step.js";
import { runTask, type Task } from "./workflows.js";

const WORKER_ID = hostname();
type Db = Pick<pg.Pool, "query">;
const setStatus = (db: Db, sql: string, params: unknown[]) =>
  db.query(`UPDATE tasks SET ${sql}, updated_at = now() WHERE task_id = $1`, params);

/**
 * PHASE 1, DELIBERATELY NAIVE (PHX-014): no lease, no fencing token, no atomic claim.
 * Runs at most one PENDING task; returns its id, or null if there was none.
 * Fixed later: atomic claim + lease (PHX-036..040), retries (PHX-026).
 */
export async function workOnce(db: Db, run: (task: Task) => ReturnType<typeof runTask> = runTask) {
  const { rows } = await db.query<Task>(
    `SELECT task_id AS "taskId", goal, input FROM tasks WHERE status = 'PENDING' ORDER BY created_at LIMIT 1`,
  );
  const task = rows[0];
  if (!task) return null;

  // THE GAP: another worker can SELECT this same row before this UPDATE lands.
  await setStatus(db, "status = 'RUNNING', owner = $2", [task.taskId, WORKER_ID]);
  try {
    const { report, tokens } = await run(task);
    await setStatus(db, "status = 'DONE', owner = NULL, tokens_used = tokens_used + $2", [task.taskId, tokens]);
    console.log(`task ${task.taskId} DONE by ${WORKER_ID}: ${report}`);
  } catch (err) {
    if (err instanceof Fenced) {
      // Another worker owns this task's work now: drop it, change nothing (design rule 5).
      console.log(`task ${task.taskId} dropped by ${WORKER_ID}: ${err.message}`);
      return task.taskId;
    }
    // Phase 1 only: no retries or leases yet, so fail the task instead of leaving it stuck.
    await setStatus(db, "status = 'FAILED', owner = NULL, failure_reason = $2", [task.taskId, String(err)]);
    console.error(`task ${task.taskId} FAILED: ${String(err)}`);
  }
  return task.taskId;
}

// Entry: node dist/src/worker.js. When idle, poll every POLL_MS ± POLL_JITTER_MS.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`worker ${WORKER_ID} started`);
  for (;;) {
    if ((await workOnce(pool)) === null) {
      await sleep(config.POLL_MS + (Math.random() * 2 - 1) * config.POLL_JITTER_MS);
    }
  }
}
