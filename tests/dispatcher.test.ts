import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatchOnce } from "../src/dispatcher.js";
import { saveEvent } from "../src/queries.js";
import { createEmail } from "../src/tools/email.js";
import { buildFakeEmail } from "../testing/fake-email.js";
import { seedTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

const fake = buildFakeEmail();
let email: ReturnType<typeof createEmail>;
let db: pg.Pool;
let drop: () => Promise<void>;
let taskId: number;
let nextStep = 1;
const stats = async () => (await fake.inject({ url: "/stats" })).json();
const outbox = async () => (await db.query("SELECT step_id, status, attempts, sent_at IS NOT NULL AS sent FROM outbox ORDER BY step_id")).rows;
const queueEmail = () =>
  saveEvent({ taskId, stepId: nextStep++, stepType: "send_email", inputHash: "h", status: "OK", result: "body", error: null, attempts: 1,
    tokens: 0, fencingToken: 0, outbox: { kind: "email", guarantee: "AT_LEAST_ONCE", recipient: "a@example.com", payload: { subject: "s", body: "b" } } }, db);

beforeAll(async () => {
  email = createEmail({ baseURL: await fake.listen({ host: "127.0.0.1", port: 0 }), timeoutMs: 5_000 });
  ({ pool: db, drop } = await createTestDb("dispatcher"));
  taskId = await seedTask(db, "goal");
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
