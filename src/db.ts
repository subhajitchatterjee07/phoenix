import pg, { type PoolClient } from "pg";
import { config } from "./config.js";

// BIGINT (type id 20) arrives as a string by default, so `token === row.fencing_token`
// would compare 7 with "7". Parse it to a number, and fail loudly past 2^53 instead of
// silently rounding (ids and fencing tokens never get near that).
pg.types.setTypeParser(pg.types.builtins.INT8, (text) => {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT ${text} does not fit in a JS number`);
  return n;
});

/** The one pool for this process. Never build another; never use it inside withTransaction's fn. */
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

/** BEGIN, run fn on ONE client, COMMIT; on any throw ROLLBACK and rethrow. Always releases.
 *  `db` defaults to the process pool; tests pass a throwaway database's pool. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>, db: pg.Pool = pool): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The connection itself is bad. Keep the caller's original error, and below
      // tell the pool to destroy this client instead of lending it out again.
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
