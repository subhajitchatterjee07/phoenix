import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Fenced, PermanentError, runWithRetries, TransientError } from "../src/step.js";

const policy = { maxAttempts: 5, baseMs: 1_000, capMs: 30_000 };
const t = () => new TransientError("503");
let calledAt: number[];
/** An attempt that fails with each given error in turn, then returns "ok". Records when it ran. */
const failing = (...errors: Error[]) => async () => {
  calledAt.push(Date.now());
  const err = errors.shift();
  if (err) throw err;
  return "ok";
};
const gaps = () => calledAt.slice(1).map((t, i) => t - calledAt[i]!);
const run = async <T>(p: Promise<T>) => { const settled = p.then((v) => v, (e: unknown) => e); await vi.runAllTimersAsync(); return settled; };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1); // full jitter at its maximum: exact delays
  calledAt = [];
});
afterEach(() => vi.useRealTimers());

it("retries transient errors with exponential backoff (1, 2, 4, 8 s) and counts attempts", async () => {
  const out = await run(runWithRetries(failing(t(), t(), t(), t()), new AbortController().signal, policy));
  expect(out).toEqual({ result: "ok", attempts: 5 });
  expect(gaps()).toEqual([1_000, 2_000, 4_000, 8_000]);
});

it("gives up after the 5th attempt with a PermanentError", async () => {
  const out = await run(runWithRetries(failing(t(), t(), t(), t(), t()), new AbortController().signal, policy));
  expect(out).toBeInstanceOf(PermanentError);
  expect(String(out)).toMatch(/gave up after 5 attempts: 503/);
  expect(calledAt).toHaveLength(5);
});

it("waits Retry-After instead of backoff, capped at 30 s", async () => {
  await run(runWithRetries(failing(new TransientError("429", 3_000), new TransientError("429", 3_600_000)), new AbortController().signal, policy));
  expect(gaps()).toEqual([3_000, 30_000]);
});

it("never retries a permanent error or Fenced", async () => {
  expect(await run(runWithRetries(failing(new PermanentError("404")), new AbortController().signal, policy))).toBeInstanceOf(PermanentError);
  expect(await run(runWithRetries(failing(new Fenced("lost")), new AbortController().signal, policy))).toBeInstanceOf(Fenced);
  expect(calledAt).toHaveLength(2); // one attempt each
});

it("an abort during the wait ends it at once with Fenced; no further attempt", async () => {
  const controller = new AbortController();
  const p = runWithRetries(failing(new TransientError("503")), controller.signal, policy).then((v) => v, (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  expect(await p).toBeInstanceOf(Fenced);
  expect(calledAt).toHaveLength(1);
});

// H5 (PHX-067): a 429 means the provider did no work, so it doesn't use one of the 5 attempts.
const r429 = () => new TransientError("429", undefined, 429);
const many429 = (n: number) => Array.from({ length: n }, r429);

it("ten 429s then OK: attempts = 1 (11 calls), and the backoff still grows through the streak", async () => {
  expect(await run(runWithRetries(failing(...many429(10)), new AbortController().signal, policy))).toEqual({ result: "ok", attempts: 1 });
  expect(calledAt).toHaveLength(11);
  expect(gaps().slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
});

it("a 503 still uses an attempt: 429, 503, 429, 503, OK is attempts = 3", async () => {
  expect(await run(runWithRetries(failing(r429(), t(), r429(), t()), new AbortController().signal, policy))).toEqual({ result: "ok", attempts: 3 });
});

it("429s for overloadMaxWaitMs since the first one: PermanentError 'provider overloaded', attempts 1", async () => {
  const err = await run(runWithRetries(failing(...many429(100)), new AbortController().signal, { ...policy, overloadMaxWaitMs: 60_000 }));
  expect(err).toBeInstanceOf(PermanentError);
  expect(err).toMatchObject({ message: expect.stringMatching(/^provider overloaded for 1\.0 min: 429$/), attempts: 1 });
  expect(calledAt).toHaveLength(7); // waits 1 + 2 + 4 + 8 + 16 + 30 = 61 s ≥ 60 s at the 7th 429
});
