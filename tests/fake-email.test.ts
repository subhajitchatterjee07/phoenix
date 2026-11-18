import { afterAll, beforeEach, expect, it } from "vitest";
import { buildFakeEmail } from "../testing/fake-email.js";

const app = buildFakeEmail();
afterAll(() => app.close());
beforeEach(() => app.inject({ method: "POST", url: "/reset" }));

const send = (key: string | undefined, body: object) =>
  app.inject({ method: "POST", url: "/emails", payload: body, headers: key ? { "idempotency-key": key } : {} });
const email = { to: "a@example.com", subject: "Report", text: "Hello" };

it("delivers once per key: a resend gets the original id back and is only counted as a request", async () => {
  const first = await send("k1", email);
  const again = await send("k1", email);
  await send("k2", email);
  expect(first.statusCode).toBe(200);
  expect(again.statusCode).toBe(200);
  expect(again.json().id).toBe(first.json().id);
  expect((await app.inject({ url: "/stats" })).json()).toEqual({
    k1: { requests: 2, deliveries: 1 },
    k2: { requests: 1, deliveries: 1 },
  });
});

it("rejects a reused key with a different body with a 409, delivering nothing new", async () => {
  await send("k1", email);
  const clash = await send("k1", { ...email, text: "Other" });
  expect(clash.statusCode).toBe(409);
  expect((await app.inject({ url: "/stats" })).json()).toEqual({ k1: { requests: 2, deliveries: 1 } });
});

it("rejects a send without an Idempotency-Key or a recipient with a 400", async () => {
  expect((await send(undefined, email)).statusCode).toBe(400);
  expect((await send("k1", { text: "no to" })).statusCode).toBe(400);
  expect((await app.inject({ url: "/stats" })).json()).toEqual({});
});
