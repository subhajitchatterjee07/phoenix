import type pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";
import { renew } from "./queries.js";
import { Fenced } from "./step.js";

type Options = { db?: Pick<pg.Pool, "query">; everyMs?: number; leaseMs?: number };

/**
 * Renews my lease every HEARTBEAT_MS (LLD §5.3) and aborts `controller` (→ Fenced) when the task
 * is no longer mine: renew hits 0 rows, or a full lease passes with no successful renew (a
 * failed renew alone is retried next beat, D-31). One renew in flight at a time. Returns stop().
 */
export function startHeartbeat(taskId: number, token: number, controller: AbortController, options: Options = {}) {
  const { db = pool, everyMs = config.HEARTBEAT_MS, leaseMs = config.LEASE_SECONDS * 1_000 } = options;
  let lastRenewed = Date.now();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const beat = async () => {
    try {
      if (!(await renew(taskId, token, db))) return controller.abort(new Fenced(`task ${taskId}: lease lost, token ${token} is stale`));
      lastRenewed = Date.now();
    } catch (err) {
      if (Date.now() - lastRenewed >= leaseMs) return controller.abort(new Fenced(`task ${taskId}: no renew for ${leaseMs} ms, last error: ${String(err)}`));
      console.error(`task ${taskId}: renew failed, retrying in ${everyMs} ms: ${String(err)}`);
    }
    if (!stopped) timer = setTimeout(beat, everyMs);
  };

  timer = setTimeout(beat, everyMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
