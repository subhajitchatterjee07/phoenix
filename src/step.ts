import { createHash } from "node:crypto";

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
