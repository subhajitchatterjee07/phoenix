import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PermanentError, TransientError } from "../src/step.js";
import { createEmail } from "../src/tools/email.js";
import { buildFakeEmail } from "../testing/fake-email.js";

const fake = buildFakeEmail();
const silent: Server = createServer(() => {}); // accepts requests, never answers
let fakeUrl = "";
let silentUrl = "";
const mail = { subject: "Report", body: "Hello" };

beforeAll(async () => {
  fakeUrl = await fake.listen({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
  silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await fake.close();
  silent.closeAllConnections();
  silent.close();
});

it("sends with the Idempotency-Key; a resend with the same key is delivered once", async () => {
  const email = createEmail({ baseURL: fakeUrl, timeoutMs: 5_000 });
  const first = await email.send("a@example.com", mail, { idempotencyKey: "k1" });
  const again = await email.send("a@example.com", mail, { idempotencyKey: "k1" });
  expect(again.id).toBe(first.id);
  expect((await fake.inject({ url: "/stats" })).json()).toEqual({ k1: { requests: 2, deliveries: 1 } });
});

it("a 4xx (409: key reused with another body) is permanent", async () => {
  const email = createEmail({ baseURL: fakeUrl, timeoutMs: 5_000 });
  const clash = email.send("a@example.com", { ...mail, body: "Other" }, { idempotencyKey: "k1" });
  await expect(clash).rejects.toBeInstanceOf(PermanentError);
  await expect(clash).rejects.toThrow(/HTTP 409/);
});

it("a timeout or a refused connection is transient: we can't know if it was delivered", async () => {
  const slow = createEmail({ baseURL: silentUrl, timeoutMs: 50 }).send("a@example.com", mail, { idempotencyKey: "k2" });
  await expect(slow).rejects.toBeInstanceOf(TransientError);
  const refused = createEmail({ baseURL: "http://127.0.0.1:1", timeoutMs: 5_000 }).send("a@example.com", mail, { idempotencyKey: "k3" });
  await expect(refused).rejects.toBeInstanceOf(TransientError);
});
