import { spawn } from "node:child_process";
import { once } from "node:events";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatchOnce } from "../src/dispatcher.js";
import { saveEvent } from "../src/queries.js";
import { PermanentError, TransientError } from "../src/step.js";
import { createEmail } from "../src/tools/email.js";
import { buildFakeEmail } from "../testing/fake-email.js";
import { seedRunningTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

const fake = buildFakeEmail();
let fakeUrl = "";
let email: ReturnType<typeof createEmail>;
let db: pg.Pool;
let drop: () => Promise<void>;
let taskId: number;
let nextStep = 1;
const stats = async () => (await fake.inject({ url: "/stats" })).json();
const outbox = async () => (await db.query("SELECT step_id, status, attempts, sent_at IS NOT NULL AS sent FROM outbox ORDER BY step_id")).rows;
const queueEmail = (guarantee: "AT_LEAST_ONCE" | "AT_MOST_ONCE" = "AT_LEAST_ONCE") =>
  saveEvent({ taskId, stepId: nextStep++, stepType: "send_email", inputHash: "h", status: "OK", result: "body", error: null, attempts: 1,
    tokens: 0, fencingToken: 0, outbox: { kind: "email", guarantee, recipient: "a@example.com", payload: { subject: "s", body: "b" } } }, db);

beforeAll(async () => {
  fakeUrl = await fake.listen({ host: "127.0.0.1", port: 0 });
  email = createEmail({ baseURL: fakeUrl, timeoutMs: 5_000 });
  ({ pool: db, drop } = await createTestDb("dispatcher"));
  taskId = await seedRunningTask(db, "goal");
});
afterAll(() => Promise.all([fake.close(), drop()]));
beforeEach(async () => {
  await db.query("DELETE FROM outbox");
  await fake.inject({ method: "POST", url: "/reset" });
});

it("an outbox row → one delivery with its idem_key → SENT; then nothing is due", async () => {
  await queueEmail();
  const key = await dispatchOnce(db, email);
  expect(await stats()).toEqual({ [key!]: { requests: 1, deliveries: 1 } });
  expect(await outbox()).toEqual([{ step_id: nextStep - 1, status: "SENT", attempts: 1, sent: true }]);
  expect(await dispatchOnce(db, email)).toBeNull();
});

const failWith = (err: Error) => ({ send: () => Promise.reject(err) });
const failure = async () =>
  (await db.query(`SELECT status, attempts, last_error, extract(epoch FROM next_attempt_at - now())::float AS wait_s FROM outbox ORDER BY step_id LIMIT 1`)).rows[0];

it.each([
  ["a transient error", new TransientError("HTTP 503"), 0, 1], // attempt 1: full jitter in [0, 1 s)
  ["an unclassified error (D-29)", new Error("socket hang up"), 0, 1],
  ["a 429 with Retry-After 60 s (capped at 30 s)", new TransientError("HTTP 429", 60_000), 29, 30],
])("%s counts an attempt, keeps the error, backs off; the row behind it is sent meanwhile", async (_, err, minS, maxS) => {
  await queueEmail();
  await queueEmail();
  await dispatchOnce(db, failWith(err));
  const row = await failure();
  expect(row).toMatchObject({ status: "PENDING", attempts: 1, last_error: String(err) });
  expect(row.wait_s).toBeGreaterThanOrEqual(minS);
  expect(row.wait_s).toBeLessThanOrEqual(maxS);
  await dispatchOnce(db, email); // the failed row is not due: the next one goes (B-29 fixed)
  expect((await outbox()).map((r) => r.status)).toEqual(["PENDING", "SENT"]);
});

it("a permanent error ends the row FAILED at once", async () => {
  await queueEmail();
  await dispatchOnce(db, failWith(new PermanentError("HTTP 422 bad address")));
  expect(await failure()).toMatchObject({ status: "FAILED", attempts: 1, last_error: "PermanentError: HTTP 422 bad address" });
});

it("the 8th failed attempt (OUTBOX_MAX_ATTEMPTS) ends the row FAILED", async () => {
  await queueEmail();
  await db.query("UPDATE outbox SET attempts = 7");
  await dispatchOnce(db, failWith(new TransientError("HTTP 503")));
  expect(await failure()).toMatchObject({ status: "FAILED", attempts: 8 });
});

it("the lock is held during the send: a second dispatcher skips that row and takes the next", async () => {
  await queueEmail();
  await queueEmail();
  let release = () => {};
  const slow = { send: (...a: Parameters<typeof email.send>) => new Promise<void>((r) => (release = r)).then(() => email.send(...a)) };
  const first = dispatchOnce(db, slow); // holds row 1 mid-send
  await new Promise((r) => setTimeout(r, 100));
  const second = await dispatchOnce(db, email);
  release();
  expect(second).not.toBe(await first);
  expect(Object.values(await stats())).toEqual([{ requests: 1, deliveries: 1 }, { requests: 1, deliveries: 1 }]);
});

it("killed after the send, before SENT: the next pass resends with the same key, delivered once", async () => {
  await queueEmail();
  // Async spawn, not spawnSync: the fake email server lives in THIS process and must keep answering.
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    `import { dispatchOnce } from "./src/dispatcher.ts"; await dispatchOnce();`],
  { env: { ...process.env, DATABASE_URL: (db as unknown as { options: { connectionString: string } }).options.connectionString,
    EMAIL_BASE_URL: fakeUrl, CRASH_AT: "after_send_before_sent" } });
  const [, signal] = await once(child, "exit");
  expect(signal).toBe("SIGKILL");
  expect((await outbox())[0].status).toBe("PENDING");
  const key = await dispatchOnce(db, email);
  expect(await stats()).toEqual({ [key!]: { requests: 2, deliveries: 1 } });
  expect((await outbox())[0].status).toBe("SENT");
});

it("AT_MOST_ONCE: SENT is committed BEFORE the send, so a crash during it can never cause a resend", async () => {
  await queueEmail("AT_MOST_ONCE");
  let statusDuringSend = "";
  const key = await dispatchOnce(db, {
    send: async (...a) => {
      statusDuringSend = (await outbox())[0].status; // another connection: only committed data
      return email.send(...a);
    },
  });
  expect(statusDuringSend).toBe("SENT");
  expect(await stats()).toEqual({ [key!]: { requests: 1, deliveries: 1 } });
});

it("AT_MOST_ONCE: a failed send is never retried; the row ends FAILED with the error", async () => {
  await queueEmail("AT_MOST_ONCE");
  await dispatchOnce(db, failWith(new TransientError("HTTP 503")));
  expect(await failure()).toMatchObject({ status: "FAILED", attempts: 1, last_error: "TransientError: HTTP 503" });
  expect(await dispatchOnce(db, email)).toBeNull();
});
