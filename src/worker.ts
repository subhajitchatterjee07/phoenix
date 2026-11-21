import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";
import { startHeartbeat } from "./heartbeat.js";
import { claim, type ClaimedTask } from "./queries.js";
import { Fenced, type StepContext } from "./step.js";
import { runTask, type Task } from "./workflows.js";

const WORKER_ID = hostname();
type Db = Pick<pg.Pool, "query">;
/** LLD §5.6: end my task, guarded by my token. 0 rows: it isn't mine any more; leave it to its owner. */
async function finish(db: Db, task: ClaimedTask, set: string, params: unknown[] = []) {
  const { rowCount } = await db.query(
    `UPDATE tasks SET ${set}, owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE task_id = $1 AND fencing_token = $2 AND status = 'RUNNING'`,
    [task.taskId, task.token, ...params],
  );
  if (rowCount === 0) console.log(`task ${task.taskId}: not mine any more at the finish (token ${task.token}), left as is`);
}

/**
 * Claims at most one task (atomic claim + lease, LLD §5.2), runs it under a heartbeat (§5.3),
 * and returns its id, or null if nothing was claimable. Not yet: Suspend and unexpected
 * errors (PHX-040).
 */
export async function workOnce(db: Db, run: (ctx: StepContext, task: Task) => Promise<string> = runTask) {
  const task = await claim(WORKER_ID, db);
  if (!task) return null;

  const controller = new AbortController(); // aborted by the heartbeat when the task is no longer mine
  const stopHeartbeat = startHeartbeat(task.taskId, task.token, controller, { db });
  try {
    const { taskId, token, maxSteps, tokenBudget, tokensUsed } = task;
    const ctx = { taskId, token, nextStepId: 1, signal: controller.signal, maxSteps, tokenBudget, tokensUsed };
    const report = await run(ctx, task);
    // tokens_used is already added per step by saveEvent; adding it here would count twice.
    await finish(db, task, "status = 'DONE'");
    console.log(`task ${task.taskId} DONE by ${WORKER_ID}: ${report}`);
  } catch (err) {
    if (err instanceof Fenced) {
      console.log(`task ${task.taskId} dropped by ${WORKER_ID}: ${err.message}`); // design rule 5
      return task.taskId;
    }
    // LimitExceeded: FAILED by design (P7). Until PHX-040, an unexpected error fails it too
    // (the LLD leaves that to lease expiry).
    await finish(db, task, "status = 'FAILED', failure_reason = $3", [String(err)]);
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
