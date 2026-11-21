import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { idemKey, loadEvent, saveEvent, type NewEvent } from "../src/queries.js";
import { createTestDb } from "../testing/test-db.js";
import { seedRunningTask } from "../testing/seed.js";

let db: pg.Pool;
let drop: () => Promise<void>;
let taskId: number;
const tokensUsed = async () =>
  (await db.query("SELECT tokens_used FROM tasks WHERE task_id = $1", [taskId])).rows[0].tokens_used;
const row = async (stepId: number) =>
  (await db.query("SELECT status, result_inline, error, tokens FROM events WHERE task_id = $1 AND step_id = $2", [taskId, stepId])).rows[0];
const event = (stepId: number, over: Partial<NewEvent> = {}): NewEvent => ({
  taskId, stepId, stepType: "llm_summarize", inputHash: "h".repeat(64), status: "OK",
  result: { summary: "s" }, error: null, attempts: 1, tokens: 10, fencingToken: 0, ...over,
});

beforeAll(async () => {
  ({ pool: db, drop } = await createTestDb("queries"));
  taskId = await seedRunningTask(db, "goal");
});
afterAll(() => drop());

it("saves a step's result as JSON and adds its tokens to the task", async () => {
  await saveEvent(event(1, { result: { summary: "s", items: ["a", "b"] } }), db);
  await saveEvent(event(2, { result: ["x", "y"] }), db); // a top-level array must stay JSON
  expect(await row(1)).toEqual({ status: "OK", result_inline: { summary: "s", items: ["a", "b"] }, error: null, tokens: 10 });
  expect((await row(2)).result_inline).toEqual(["x", "y"]);
  expect(await tokensUsed()).toBe(20);
});

it("rejects a second save of the same step, and rolls its token update back", async () => {
  const before = await tokensUsed();
  await expect(saveEvent(event(1, { tokens: 500 }), db)).rejects.toMatchObject({ code: "23505" }); // unique_violation
  expect(await tokensUsed()).toBe(before);
});

it("refuses a result over INLINE_RESULT_MAX_BYTES with a clear error, saving nothing", async () => {
  await expect(saveEvent(event(4, { result: "x".repeat(70_000) }), db)).rejects.toThrow(/INLINE_RESULT_MAX_BYTES.*PHX-064/);
  expect(await row(4)).toBeUndefined();
});

it("loadEvent returns exactly what saveEvent stored", async () => {
  expect(await loadEvent(taskId, 1, db)).toEqual({
    stepType: "llm_summarize", inputHash: "h".repeat(64), status: "OK",
    result: { summary: "s", items: ["a", "b"] }, error: null, attempts: 1, tokens: 10,
  });
  expect((await loadEvent(taskId, 2, db))?.result).toEqual(["x", "y"]);
});

it("loadEvent returns null for a step that never finished", async () => {
  expect(await loadEvent(taskId, 99, db)).toBeNull();
});

it("loadEvent returns a recorded ERROR as a value: no result, the error text", async () => {
  await saveEvent(event(3, { status: "ERROR", result: undefined, error: "404 Not Found", attempts: 5 }), db);
  expect(await loadEvent(taskId, 3, db)).toMatchObject({ status: "ERROR", result: null, error: "404 Not Found", attempts: 5 });
});

const email = { kind: "email", guarantee: "AT_LEAST_ONCE", recipient: "a@example.com", payload: { subject: "s", body: "b" } } as const;
const outboxRow = async (stepId: number) =>
  (await db.query("SELECT idem_key, kind, guarantee, recipient, payload, status FROM outbox WHERE task_id = $1 AND step_id = $2", [taskId, stepId])).rows[0];

it("a side-effect step saves its event and a PENDING outbox row keyed sha256('task:step')", async () => {
  await saveEvent(event(5, { outbox: email }), db);
  expect(await row(5)).toMatchObject({ status: "OK" });
  expect(await outboxRow(5)).toEqual({
    idem_key: createHash("sha256").update(`${taskId}:5`).digest("hex"),
    kind: "email", guarantee: "AT_LEAST_ONCE", recipient: "a@example.com", payload: { subject: "s", body: "b" }, status: "PENDING",
  });
});

it("if the outbox insert fails, the event and the tokens roll back with it", async () => {
  await db.query("INSERT INTO outbox (idem_key, task_id, step_id, kind, guarantee, recipient, payload) VALUES ($1, $2, 6, 'email', 'AT_LEAST_ONCE', 'x', '{}')", [idemKey(taskId, 6), taskId]);
  const before = await tokensUsed();
  await expect(saveEvent(event(6, { outbox: email }), db)).rejects.toMatchObject({ code: "23505" });
  expect(await row(6)).toBeUndefined();
  expect(await tokensUsed()).toBe(before);
});

// kill -9 in the middle of saveEvent: a real child process on this test's database.
const saveAndCrash = (stepId: number, crashAt: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { saveEvent } from "./src/queries.ts";
    await saveEvent(${JSON.stringify(event(stepId, { outbox: email }))});
    console.log("returned");`],
  { env: { ...process.env, DATABASE_URL: (db as unknown as { options: { connectionString: string } }).options.connectionString, CRASH_AT: crashAt }, encoding: "utf8", timeout: 20_000 });

it("killed between the event and outbox inserts: neither row exists", async () => {
  const child = saveAndCrash(7, "between_event_and_outbox");
  expect(child.signal).toBe("SIGKILL");
  expect(await row(7)).toBeUndefined();
  expect(await outboxRow(7)).toBeUndefined();
});

it("killed right after the commit: both rows exist, so a restart replays the step and sends nothing new", async () => {
  const child = saveAndCrash(8, "after_outbox_commit");
  expect(child.signal).toBe("SIGKILL");
  expect(child.stdout).toBe("");
  expect(await row(8)).toMatchObject({ status: "OK" });
  expect(await outboxRow(8)).toMatchObject({ status: "PENDING" });
});

it.each([
  ["my token is stale (another worker claimed it)", "fencing_token = fencing_token + 1"],
  ["my lease has expired", "lease_expires_at = now() - interval '1 second'"],
  ["the task left RUNNING", "status = 'DONE'"],
])("the guard: a save when %s writes nothing (no event, no outbox row, no tokens) and returns false", async (_, change) => {
  const id = await seedRunningTask(db, "guarded");
  await db.query(`UPDATE tasks SET ${change} WHERE task_id = $1`, [id]);
  expect(await saveEvent({ ...event(1, { outbox: email }), taskId: id }, db)).toBe(false);
  const counts = await db.query(`SELECT (SELECT count(*) FROM events WHERE task_id = $1)::int AS events,
    (SELECT count(*) FROM outbox WHERE task_id = $1)::int AS outbox, tokens_used FROM tasks WHERE task_id = $1`, [id]);
  expect(counts.rows[0]).toEqual({ events: 0, outbox: 0, tokens_used: 0 });
});
