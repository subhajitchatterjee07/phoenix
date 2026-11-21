import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import { failpoint } from "./failpoint.js";
import { email } from "./tools/email.js";

type Provider = Pick<typeof email, "send">;
const IDLE_MS = 2_000; // LLD §7

/**
 * Sends at most one due outbox row; returns its idem_key, or null if none was due (LLD §7).
 * The row lock is HELD during the send (D-28): other dispatchers skip it; a crash drops it and
 * the next pass resends with the same key. PHX-033: attempts, backoff, FAILED, AT_MOST_ONCE.
 */
export async function dispatchOnce(db: pg.Pool = pool, provider: Provider = email): Promise<string | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ idemKey: string; recipient: string; payload: object }>(
      `SELECT idem_key AS "idemKey", recipient, payload FROM outbox
       WHERE status = 'PENDING' AND next_attempt_at <= now()
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const row = rows[0];
    if (!row) return null;
    await provider.send(row.recipient, row.payload, { idempotencyKey: row.idemKey });
    failpoint("after_send_before_sent"); // Chaos 4: delivered, but the row still says PENDING
    await client.query("UPDATE outbox SET status = 'SENT', sent_at = now(), attempts = attempts + 1 WHERE idem_key = $1", [row.idemKey]);
    return row.idemKey;
  }, db);
}

// Entry: node dist/src/dispatcher.js. Never reads or writes `tasks` (LLD §7).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("dispatcher started");
  for (;;) {
    try {
      const key = await dispatchOnce();
      if (key) console.log(`outbox ${key.slice(0, 12)}… SENT`);
      else await sleep(IDLE_MS);
    } catch (err) {
      console.error(`dispatch failed, row left PENDING: ${String(err)}`); // retry bookkeeping: PHX-033
      await sleep(IDLE_MS);
    }
  }
}
