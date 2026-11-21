import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyHttp, Fenced, PermanentError, TransientError } from "../src/step.js";
import { createLlm } from "../src/tools/llm.js";
import { buildFakeLlm, type Faults } from "../testing/fake-llm.js";

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

describe("the LLM client turns every failure into an LLD §4.3 type", () => {
  const fake = buildFakeLlm();
  let llm: ReturnType<typeof createLlm>;
  const ask = (signal?: AbortSignal) =>
    llm.chat([{ role: "user", content: "hi" }], { taskId: 1, stepId: 1, ...(signal ? { signal } : {}) });
  const faults = (f: Partial<Faults>) => fake.inject({ method: "POST", url: "/faults", payload: f });

  beforeAll(async () => {
    llm = createLlm({ baseURL: `${await fake.listen({ host: "127.0.0.1", port: 0 })}/v1`, apiKey: "k", model: "m", timeoutMs: 300 });
  });
  afterAll(() => fake.close());
  beforeEach(() => faults({ rate429: 0, retryAfterS: null, rate5xx: 0, rateHang: 0 }));

  it("429 → TransientError carrying Retry-After", async () => {
    await faults({ rate429: 1, retryAfterS: 3 });
    await expect(ask()).rejects.toMatchObject({ name: "TransientError", retryAfterMs: 3_000 });
  });
  it("500 → TransientError", async () => {
    await faults({ rate5xx: 1 });
    await expect(ask()).rejects.toBeInstanceOf(TransientError);
  });
  it("no answer before the timeout → TransientError", async () => {
    await faults({ rateHang: 1 });
    await expect(ask()).rejects.toBeInstanceOf(TransientError);
  });
  it("400 (a request the API rejects) → PermanentError", async () => {
    await expect(llm.chat([], { taskId: 1, stepId: 1 })).rejects.toBeInstanceOf(PermanentError);
  });
  it("our own abort (lease lost) → Fenced, never retried", async () => {
    await faults({ rateHang: 1 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(ask(controller.signal)).rejects.toBeInstanceOf(Fenced);
  });
});
