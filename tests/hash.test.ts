import { describe, expect, it } from "vitest";
import { canonicalJson, inputHash } from "../src/step.js";

describe("canonicalJson", () => {
  it("sorts keys at every level, so key order never changes the text", () => {
    // JSON.stringify gives two different strings for these: the reason this function exists.
    expect(JSON.stringify({ a: 1, b: 2 })).not.toBe(JSON.stringify({ b: 2, a: 1 }));
    expect(canonicalJson({ b: { y: 1, x: [2, { d: 1, c: 2 }] }, a: "s" })).toBe(
      '{"a":"s","b":{"x":[2,{"c":2,"d":1}],"y":1}}',
    );
  });

  it.each([
    ["undefined", { x: undefined }], // JSON.stringify silently drops the key
    ["NaN", [NaN]], // JSON.stringify turns it into null
    ["Infinity", { n: Infinity }],
    ["a function", { f: () => 1 }],
    ["a BigInt", { n: 1n }],
    ["a Date", { at: new Date(0) }], // JSON.stringify would call toJSON() and hide the type
    ["a sparse array", [1, , 3]], // eslint-disable-line no-sparse-arrays
  ])("throws on %s instead of losing information", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe("inputHash", () => {
  const args = { textRef: 7, focus: "pricing" };

  it("is a 64-character hex sha256, equal for equal calls whatever the key order", () => {
    expect(inputHash("llm_summarize", args)).toMatch(/^[0-9a-f]{64}$/);
    expect(inputHash("llm_summarize", { focus: "pricing", textRef: 7 })).toBe(inputHash("llm_summarize", args));
  });

  it("changes when the args, their array order, or the step type change", () => {
    const base = inputHash("llm_summarize", args);
    expect(inputHash("llm_summarize", { ...args, focus: "cost" })).not.toBe(base);
    expect(inputHash("write_report", args)).not.toBe(base);
    expect(inputHash("t", { ids: [1, 2] })).not.toBe(inputHash("t", { ids: [2, 1] }));
  });
});
