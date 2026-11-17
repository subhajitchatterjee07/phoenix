import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createLlm } from "../src/tools/llm.js";
import { buildFakeLlm } from "../testing/fake-llm.js";

const fake = buildFakeLlm();
const silent: Server = createServer(() => {}); // accepts requests, never answers
let fakeUrl = "";
let silentUrl = "";
const messages = [{ role: "user" as const, content: "hello" }];
const settings = (baseURL: string, timeoutMs = 5_000) => ({ baseURL, apiKey: "k", model: "m", timeoutMs });

beforeAll(async () => {
  fakeUrl = `${await fake.listen({ host: "127.0.0.1", port: 0 })}/v1`;
  await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
  silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  await fake.close();
  silent.closeAllConnections();
  silent.close();
});

it("returns content and tokens, and tags the call with task and step", async () => {
  const reply = await createLlm(settings(fakeUrl)).chat(messages, { taskId: 42, stepId: 7 });
  expect(reply.content).toMatch(/^fake answer /);
  expect(reply.tokens).toBeGreaterThan(0);
  expect((await fake.inject({ url: "/stats" })).json()).toEqual({ "42:7": 1 });
});

it("stops waiting as soon as the signal is aborted", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = createLlm(settings(silentUrl)).chat(messages, { taskId: 1, stepId: 1, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toThrow(/abort/i);
  expect(Date.now() - started).toBeLessThan(1_000);
});

it("gives up after the timeout, with no hidden retries", async () => {
  const started = Date.now();
  await expect(createLlm(settings(silentUrl, 200)).chat(messages, { taskId: 1, stepId: 1 })).rejects.toThrow(/timed out/i);
  expect(Date.now() - started).toBeLessThan(1_000); // one 200 ms attempt, not three
});
