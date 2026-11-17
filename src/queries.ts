import type pg from "pg";
import { config } from "./config.js";
import { pool, withTransaction } from "./db.js";

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

export type NewEvent = SavedEvent & { taskId: number; stepId: number; fencingToken: number };

/**
 * Saves a finished step and adds its tokens to the task, in ONE transaction (LLD §5.4).
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
  }, db);
}
