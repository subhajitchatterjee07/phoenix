import { createHash } from "node:crypto";
import type pg from "pg";
import { loadEvent } from "./queries.js";

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

// ---- step(), part 1: replay lookup (LLD §4.2 step 1) ----

export async function step<T>(
  ctx: StepContext,
  type: string,
  /* eslint-disable @typescript-eslint/no-unused-vars -- args is hashed and fn is called from PHX-019 on */
  args: unknown,
  fn: (args: unknown) => Promise<T>,
  /* eslint-enable @typescript-eslint/no-unused-vars */
): Promise<StepResult<T>> {
  const stepId = ctx.nextStepId++; // assigned in call order, so replay sees the same ids
  const saved = await loadEvent(ctx.taskId, stepId, ctx.db);
  if (saved) {
    // PHX-019: compare saved.inputHash with inputHash(type, args) and throw NonDeterminism.
    return saved.status === "OK" ? { ok: true, value: saved.result as T } : { ok: false, error: saved.error ?? "" };
  }
  throw new Error(`step ${stepId} (${type}) has no saved result; running new steps arrives in PHX-019`);
}
