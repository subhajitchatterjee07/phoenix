import { createHash } from "node:crypto";
import type pg from "pg";
import { loadEvent, saveEvent } from "./queries.js";

/**
 * JSON text that is identical for equal values: object keys sorted at every level,
 * array order kept. Throws instead of silently dropping or changing what JSON.stringify
 * would lose (undefined, NaN, Infinity, functions, BigInt, Dates, class instances),
 * because a lossy fingerprint could make two different calls look the same on replay.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} has no JSON form`);
    return JSON.stringify(value);
  }
  // Array.from turns holes in sparse arrays into undefined, which then throws below.
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: ${proto?.constructor?.name ?? "object"} is not a plain object`);
    }
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: ${typeof value} has no JSON form`); // undefined, function, bigint, symbol
}

/** Fingerprint of a step call (LLD §4.2); replay compares it with events.input_hash. */
export function inputHash(type: string, args: unknown): string {
  return createHash("sha256").update(canonicalJson({ type, args })).digest("hex");
}

// ---- Types and errors (LLD §4.1) ----

export interface StepContext {
  taskId: number;
  token: number; // fencing token from my claim
  nextStepId: number; // starts at 1; +1 on every step() call, in call order
  signal: AbortSignal; // aborted by the heartbeat if a renew returns 0 rows
  maxSteps: number;
  db?: pg.Pool; // tests only: a throwaway database; defaults to the process pool
}

/** Recorded errors are values, not exceptions: replay must return the same outcome. */
export type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class Suspend extends Error { override name = "Suspend"; } // task paused (approval): stop executing
export class Fenced extends Error { override name = "Fenced"; } // my write was rejected: drop the task
export class NonDeterminism extends Error { override name = "NonDeterminism"; } // saved step replayed with other args
export class PermanentError extends Error { override name = "PermanentError"; }
export class TransientError extends Error {
  override name = "TransientError";
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
  }
}

// ---- step() (LLD §4.2) ----

/** What a step function returns: its value, and the LLM tokens it spent (omit for 0). */
export type StepOutput<T> = { value: T; tokens?: number };
/** What a step function is told: its id (e.g. for the X-Phoenix-Step header) and the abort signal. */
export type StepMeta = { stepId: number; signal: AbortSignal };

export async function step<A, T>(
  ctx: StepContext,
  type: string,
  args: A,
  fn: (args: A, meta: StepMeta) => Promise<StepOutput<T>>,
): Promise<StepResult<T>> {
  const stepId = ctx.nextStepId++; // assigned in call order, so replay sees the same ids
  const hash = inputHash(type, args);

  // 1. Replay: a finished step returns its saved outcome and runs nothing.
  const saved = await loadEvent(ctx.taskId, stepId, ctx.db);
  if (saved) {
    if (saved.inputHash !== hash) {
      throw new NonDeterminism(
        `task ${ctx.taskId} step ${stepId} (${type}) was saved with input_hash ${saved.inputHash.slice(0, 12)}… ` +
          `but is now called with ${hash.slice(0, 12)}…: the workflow code or its inputs changed`,
      );
    }
    return saved.status === "OK" ? { ok: true, value: saved.result as T } : { ok: false, error: saved.error ?? "" };
  }

  // 2. A fenced worker starts no new work. Step limit and token budget: PHX-039.
  if (ctx.signal.aborted) throw new Fenced(`task ${ctx.taskId} step ${stepId}: lease lost, not running ${type}`);

  // 3. Run once. If fn throws, nothing is saved: the step never happened, as after a crash.
  //    Retries arrive in PHX-026, recorded ERROR rows in PHX-027.
  const { value, tokens = 0 } = await fn(args, { stepId, signal: ctx.signal });
  // Return exactly what a replay will return (JSON), and reject values JSON would change.
  const result = JSON.parse(canonicalJson(value)) as T;

  // 4. Save. Unguarded until PHX-038 (my fencing token AND a live lease). Until then, a
  //    duplicate key means another worker saved this step first: we lost, so drop the task
  //    (design rule 5), exactly as a rejected guarded write will.
  try {
    await saveEvent(
      { taskId: ctx.taskId, stepId, stepType: type, inputHash: hash, status: "OK", result, error: null, attempts: 1, tokens, fencingToken: ctx.token },
      ctx.db,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    throw new Fenced(`task ${ctx.taskId} step ${stepId}: another worker already saved it`, { cause: err });
  }
  return { ok: true, value: result };
}

// ---- Built-in steps for the two everyday sources of non-determinism (LLD §4.5) ----
// Workflow code must never call Date.now() or Math.random() directly (ESLint enforces it in
// src/workflows.ts): a replay would see a different value and could take a different branch.

/** The current time in epoch milliseconds, read once and replayed forever after. */
export async function now(ctx: StepContext): Promise<number> {
  return expectOk(await step(ctx, "now", {}, async () => ({ value: Date.now() })));
}

/** A random number in [0, 1), drawn once and replayed forever after. */
export async function random(ctx: StepContext): Promise<number> {
  return expectOk(await step(ctx, "random", {}, async () => ({ value: Math.random() })));
}

function expectOk<T>(result: StepResult<T>): T {
  if (!result.ok) throw new Error(`built-in step failed: ${result.error}`); // cannot happen: never saved as ERROR
  return result.value;
}
