import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { config } from "./config.js";
import { pool, withTransaction } from "./db.js";
import { failpoint } from "./failpoint.js";
import { backoffMs, PermanentError, TransientError } from "./step.js";
import { email } from "./tools/email.js";

type Provider = Pick<typeof email, "send">;
const IDLE_MS = 2_000; // LLD §7

/**
 * Sends at most one due outbox row; returns its idem_key, or null if none was due (LLD §7).
 * The row lock is HELD during the send (D-28): other dispatchers skip it; a crash drops it and
 * the next pass resends with the same key. A failed send is recorded (see recordFailure).
 * AT_MOST_ONCE: PHX-033b.
 */
export async function dispatchOnce(db: pg.Pool = pool, provider: Provider = email): Promise<string | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ idemKey: string; recipient: string; payload: object; attempts: number }>(
      `SELECT idem_key AS "idemKey", recipient, payload, attempts FROM outbox
       WHERE status = 'PENDING' AND next_attempt_at <= now()
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const row = rows[0];
    if (!row) return null;
    try {
      await provider.send(row.recipient, row.payload, { idempotencyKey: row.idemKey });
    } catch (err) {
      await recordFailure(client, row.idemKey, row.attempts + 1, err);
      return row.idemKey;
    }
    failpoint("after_send_before_sent"); // Chaos 4: delivered, but the row still says PENDING
    await client.query("UPDATE outbox SET status = 'SENT', sent_at = now(), attempts = attempts + 1 WHERE idem_key = $1", [row.idemKey]);
    console.log(`outbox ${row.idemKey.slice(0, 12)}… SENT`);
    return row.idemKey;
  }, db);
}

/**
 * LLD §7: a permanent error, or the OUTBOX_MAX_ATTEMPTS-th failure, ends the row as FAILED
 * (alert). Anything else, even an unclassified error (D-29), backs off like a step retry and
 * leaves the row PENDING, so rows behind it are sent meanwhile.
 */
async function recordFailure(client: pg.PoolClient, idemKey: string, attempts: number, err: unknown) {
  const error = String(err);
  if (err instanceof PermanentError || attempts >= config.OUTBOX_MAX_ATTEMPTS) {
    await client.query("UPDATE outbox SET status = 'FAILED', attempts = $2, last_error = $3 WHERE idem_key = $1", [idemKey, attempts, error]);
    console.error(`ALERT outbox ${idemKey.slice(0, 12)}… FAILED after ${attempts} attempt(s): ${error}`);
    return;
  }
  const waitMs = backoffMs(attempts, err instanceof TransientError ? err.retryAfterMs : undefined);
  await client.query(
    "UPDATE outbox SET attempts = $2, last_error = $3, next_attempt_at = now() + $4 * interval '1 millisecond' WHERE idem_key = $1",
    [idemKey, attempts, error, waitMs],
  );
  console.error(`outbox ${idemKey.slice(0, 12)}… attempt ${attempts} failed, retry in ${Math.round(waitMs)} ms: ${error}`);
}

// Entry: node dist/src/dispatcher.js. Never reads or writes `tasks` (LLD §7).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("dispatcher started");
  for (;;) {
    try {
      if ((await dispatchOnce()) === null) await sleep(IDLE_MS);
    } catch (err) {
      console.error(`dispatch failed, row left PENDING: ${String(err)}`); // e.g. the database is down
      await sleep(IDLE_MS);
    }
  }
}
