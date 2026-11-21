import { createHash } from "node:crypto";
import type pg from "pg";
import { config } from "./config.js";
import { pool, withTransaction } from "./db.js";
import { failpoint } from "./failpoint.js";

// Every SQL statement of LLD §5, one function each. Added ticket by ticket.

export type SavedEvent = {
  stepType: string;
  inputHash: string;
  status: "OK" | "ERROR";
  result: unknown; // null when status is ERROR
  error: string | null;
  attempts: number;
  tokens: number;
};

/** A finished step's saved row (LLD §4.2 step 1), or null if the step never finished. */
export async function loadEvent(taskId: number, stepId: number, db: pg.Pool = pool): Promise<SavedEvent | null> {
  const { rows } = await db.query<SavedEvent>(
    `SELECT step_type AS "stepType", input_hash AS "inputHash", status, result_inline AS result,
            error, attempts, tokens
     FROM events WHERE task_id = $1 AND step_id = $2`,
    [taskId, stepId],
  );
  return rows[0] ?? null;
}

/** A side effect for the dispatcher to perform (LLD §2 outbox). Saved only with an OK event. */
export type OutboxRow = { kind: "email"; guarantee: "AT_LEAST_ONCE" | "AT_MOST_ONCE"; recipient: string; payload: unknown };
export type NewEvent = SavedEvent & { taskId: number; stepId: number; fencingToken: number; outbox?: OutboxRow | undefined };

/** Same on every retry of one step, different across steps (HLD D4): the provider dedupes on it. */
export const idemKey = (taskId: number, stepId: number) => createHash("sha256").update(`${taskId}:${stepId}`).digest("hex");

/**
 * Saves a finished step, adds its tokens to the task and, for a side-effect step, writes its
 * outbox row, all in ONE transaction (LLD §5.4, §5.5): a crash leaves all of them or none.
 * Returns false, having written nothing, if the task is no longer mine (step() → Fenced).
 */
export async function saveEvent(e: NewEvent, db: pg.Pool = pool): Promise<boolean> {
  // JSON.stringify, not the raw value: pg would send a JS array as a Postgres array, not JSON.
  const json = e.result === undefined ? null : JSON.stringify(e.result);
  const bytes = json === null ? 0 : Buffer.byteLength(json);
  if (bytes > config.INLINE_RESULT_MAX_BYTES) {
    // result_pointer + blob storage are not built yet: parked ticket PHX-064 on the board.
    throw new Error(
      `task ${e.taskId} step ${e.stepId}: result is ${bytes} bytes, over INLINE_RESULT_MAX_BYTES ` +
        `(${config.INLINE_RESULT_MAX_BYTES}); blob storage for large results is not built yet (PHX-064)`,
    );
  }
  const fenced = new Error("fenced"); // thrown to ROLLBACK, caught below
  const saved = await withTransaction(async (client) => {
    // THE GUARD (LLD §5.4, D-32): add my tokens only if the task is still mine (my token, a live
    // lease, RUNNING). It also row-locks the task until COMMIT, so no claim can bump the token
    // between this check and the inserts below. 0 rows: write nothing.
    const guard = await client.query(
      `UPDATE tasks SET tokens_used = tokens_used + $2, updated_at = now()
       WHERE task_id = $1 AND fencing_token = $3 AND lease_expires_at > now() AND status = 'RUNNING'`,
      [e.taskId, e.tokens, e.fencingToken],
    );
    if (guard.rowCount === 0) throw fenced;
    await client.query(
      `INSERT INTO events (task_id, step_id, step_type, input_hash, status, result_inline,
                           error, attempts, tokens, fencing_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [e.taskId, e.stepId, e.stepType, e.inputHash, e.status, json, e.error, e.attempts, e.tokens, e.fencingToken],
    );
    if (!e.outbox) return;
    failpoint("between_event_and_outbox"); // Chaos 4: the events row must roll back too
    const { kind, guarantee, recipient, payload } = e.outbox;
    await client.query(
      `INSERT INTO outbox (idem_key, task_id, step_id, kind, guarantee, recipient, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [idemKey(e.taskId, e.stepId), e.taskId, e.stepId, kind, guarantee, recipient, JSON.stringify(payload)],
    );
  }, db).then(() => true, (err: unknown) => {
    if (err === fenced) return false;
    throw err;
  });
  if (!saved) return false;
  if (e.outbox) failpoint("after_outbox_commit"); // Chaos 4: saved and queued, step() never returned
  return true;
}

export type ClaimedTask = {
  taskId: number; token: number; goal: string; input: unknown; maxSteps: number; tokenBudget: number | null; tokensUsed: number;
};

/**
 * LLD §5.2: atomically take the oldest claimable task: PENDING, or RUNNING with an expired
 * lease (a takeover). One statement, so two workers can never both win: SKIP LOCKED makes a
 * concurrent claimer pass over the row being claimed and take the next one. Each claim bumps
 * the fencing token, so the previous owner's writes can be rejected (PHX-038).
 */
export async function claim(me: string, db: Pick<pg.Pool, "query"> = pool): Promise<ClaimedTask | null> {
  const { rows } = await db.query<ClaimedTask>(
    `UPDATE tasks
     SET owner = $1, status = 'RUNNING', fencing_token = fencing_token + 1,
         lease_expires_at = now() + $2 * interval '1 second', updated_at = now()
     WHERE task_id = (
       SELECT task_id FROM tasks
       WHERE status IN ('PENDING', 'RUNNING') -- an allowlist (design rule 8)
         AND (lease_expires_at IS NULL OR lease_expires_at < now()) -- NULL < now() is not true
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING task_id AS "taskId", fencing_token AS token, goal, input, max_steps AS "maxSteps",
               token_budget AS "tokenBudget", tokens_used AS "tokensUsed"`,
    [me, config.LEASE_SECONDS],
  );
  return rows[0] ?? null;
}

/** LLD §5.3: extend my lease. false = 0 rows: my token is stale (someone claimed it) or it isn't RUNNING. */
export async function renew(taskId: number, token: number, db: Pick<pg.Pool, "query"> = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE tasks SET lease_expires_at = now() + $3 * interval '1 second'
     WHERE task_id = $1 AND fencing_token = $2 AND status = 'RUNNING'`,
    [taskId, token, config.LEASE_SECONDS],
  );
  return rowCount === 1;
}
