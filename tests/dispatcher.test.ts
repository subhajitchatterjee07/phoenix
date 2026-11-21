import { spawn } from "node:child_process";
import { once } from "node:events";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatchOnce } from "../src/dispatcher.js";
import { saveEvent } from "../src/queries.js";
import { createEmail } from "../src/tools/email.js";
import { buildFakeEmail } from "../testing/fake-email.js";
import { seedTask } from "../testing/seed.js";
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
const queueEmail = () =>
  saveEvent({ taskId, stepId: nextStep++, stepType: "send_email", inputHash: "h", status: "OK", result: "body", error: null, attempts: 1,
    tokens: 0, fencingToken: 0, outbox: { kind: "email", guarantee: "AT_LEAST_ONCE", recipient: "a@example.com", payload: { subject: "s", body: "b" } } }, db);

beforeAll(async () => {
  fakeUrl = await fake.listen({ host: "127.0.0.1", port: 0 });
  email = createEmail({ baseURL: fakeUrl, timeoutMs: 5_000 });
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

it("a failed send rolls back: the row stays PENDING, untouched", async () => {
  await queueEmail();
  await expect(dispatchOnce(db, { send: () => Promise.reject(new Error("provider down")) })).rejects.toThrow("provider down");
  expect(await outbox()).toEqual([{ step_id: nextStep - 1, status: "PENDING", attempts: 0, sent: false }]);
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
