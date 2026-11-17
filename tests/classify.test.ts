import { describe, expect, it } from "vitest";
import { classifyHttp, PermanentError, TransientError } from "../src/step.js";

describe("classifyHttp (LLD §4.3)", () => {
  it.each([429, 408, 500, 502, 503])("%i is transient", (status) => {
    expect(classifyHttp(status, "x")).toBeInstanceOf(TransientError);
  });
  it.each([400, 401, 403, 404, 409, 422])("%i is permanent", (status) => {
    expect(classifyHttp(status, "x")).toBeInstanceOf(PermanentError);
  });
  it("reads Retry-After as seconds or as an HTTP date; ignores anything else", () => {
    expect(classifyHttp(429, "x", "7")).toMatchObject({ retryAfterMs: 7_000 });
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect((classifyHttp(429, "x", inTenSeconds) as TransientError).retryAfterMs).toBeGreaterThan(8_000);
    expect(classifyHttp(429, "x", "soon")).toMatchObject({ retryAfterMs: undefined });
  });
});
