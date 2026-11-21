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
 * UNGUARDED for now: no "my fencing token AND live lease" check until PHX-038 (phase 5).
 */
export async function saveEvent(e: NewEvent, db: pg.Pool = pool): Promise<void> {
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
  await withTransaction(async (client) => {
    // Tokens first, then the event: if the insert fails (duplicate step), the token
    // update must roll back with it. The test relies on this order to prove atomicity.
    await client.query("UPDATE tasks SET tokens_used = tokens_used + $2, updated_at = now() WHERE task_id = $1", [
      e.taskId,
      e.tokens,
    ]);
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
  }, db);
  if (e.outbox) failpoint("after_outbox_commit"); // Chaos 4: saved and queued, step() never returned
}
