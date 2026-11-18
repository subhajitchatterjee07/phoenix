import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";

// A fake email provider that dedupes like Stripe / Resend: the dispatcher's Idempotency-Key
// (idem_key = hash(task_id, step_id)) makes a resend after a crash harmless. Chaos 4 reads
// GET /stats to check "exactly one delivery per key". No fault knobs yet (decision D-25).
type Sent = { id: string; body: string; requests: number };

export function buildFakeEmail() {
  const app = Fastify();
  const sent = new Map<string, Sent>(); // Idempotency-Key → the one delivery made for it

  app.post<{ Body: { to?: unknown } }>("/emails", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key === "") {
      return reply.code(400).send({ error: "Idempotency-Key header is required" }); // our dispatcher always sends one
    }
    if (typeof req.body?.to !== "string") return reply.code(400).send({ error: "to is required" });
    // Same code, same JSONB column on every retry, so key order is stable.
    const body = JSON.stringify(req.body);
    const earlier = sent.get(key);
    if (earlier) {
      earlier.requests++;
      // Same key, different email: two steps produced one key (D4 says they must differ).
      if (earlier.body !== body) return reply.code(409).send({ error: "Idempotency-Key reused with a different body" });
      return { id: earlier.id }; // a replay: the original answer, nothing delivered
    }
    const id = randomUUID();
    sent.set(key, { id, body, requests: 1 });
    return { id };
  });

  // deliveries is 1 per key by construction; a dispatcher that changed keys shows up as extra keys.
  app.get("/stats", async () =>
    Object.fromEntries([...sent].map(([key, s]) => [key, { requests: s.requests, deliveries: 1 }])));
  app.post("/reset", async () => {
    sent.clear();
    return { ok: true };
  });
  return app;
}

// CLI entry: npm run fake-email
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_EMAIL_PORT ?? 9002);
  await buildFakeEmail().listen({ host: "0.0.0.0", port });
  console.log(`fake email on http://localhost:${port}`);
}
