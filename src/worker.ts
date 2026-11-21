import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";
import { startHeartbeat } from "./heartbeat.js";
import { claim } from "./queries.js";
import { Fenced, type StepContext } from "./step.js";
import { runTask, type Task } from "./workflows.js";

const WORKER_ID = hostname();
type Db = Pick<pg.Pool, "query">;
const setStatus = (db: Db, sql: string, params: unknown[]) =>
  db.query(`UPDATE tasks SET ${sql}, updated_at = now() WHERE task_id = $1`, params);

/**
 * Claims at most one task (atomic claim + lease, LLD §5.2), runs it under a heartbeat (§5.3),
 * and returns its id, or null if nothing was claimable. Not yet: guarded saves (PHX-038),
 * guarded DONE / FAILED (PHX-039), Suspend and unexpected errors (PHX-040).
 */
export async function workOnce(db: Db, run: (ctx: StepContext, task: Task) => Promise<string> = runTask) {
  const task = await claim(WORKER_ID, db);
  if (!task) return null;

  const controller = new AbortController(); // aborted by the heartbeat when the task is no longer mine
  const stopHeartbeat = startHeartbeat(task.taskId, task.token, controller, { db });
  try {
    const ctx = { taskId: task.taskId, token: task.token, nextStepId: 1, signal: controller.signal, maxSteps: task.maxSteps };
    const report = await run(ctx, task);
    // tokens_used is already added per step by saveEvent; adding it here would count twice.
    await setStatus(db, "status = 'DONE', owner = NULL, lease_expires_at = NULL", [task.taskId]);
    console.log(`task ${task.taskId} DONE by ${WORKER_ID}: ${report}`);
  } catch (err) {
    if (err instanceof Fenced) {
      console.log(`task ${task.taskId} dropped by ${WORKER_ID}: ${err.message}`); // design rule 5
      return task.taskId;
    }
    // Until PHX-040: an unexpected error fails the task (the LLD leaves it to lease expiry).
    await setStatus(db, "status = 'FAILED', owner = NULL, lease_expires_at = NULL, failure_reason = $2", [task.taskId, String(err)]);
    console.error(`task ${task.taskId} FAILED: ${String(err)}`);
  } finally {
    stopHeartbeat();
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
