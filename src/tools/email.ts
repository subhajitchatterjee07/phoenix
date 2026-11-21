import { config } from "../config.js";
import { classifyHttp, TransientError } from "../step.js";

export type EmailSettings = { baseURL: string; timeoutMs: number };

/**
 * The dispatcher's email provider (LLD §7). The same Idempotency-Key on every resend of one
 * outbox row lets the provider deliver it once. Errors come back as LLD §4.3 types.
 */
export function createEmail(settings: EmailSettings) {
  return {
    async send(to: string, payload: object, { idempotencyKey }: { idempotencyKey: string }): Promise<{ id: string }> {
      const where = `email to ${to} (key ${idempotencyKey.slice(0, 12)}…)`;
      let res: Response;
      try {
        res = await fetch(`${settings.baseURL}/emails`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ to, ...payload }),
          // Bounds how long the dispatcher holds the outbox row lock (D-28).
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (err) {
        // Timeout, refused, reset: we can't know if it was delivered, so resend with the same key.
        throw new TransientError(`${where}: ${(err as Error).message}`);
      }
      if (!res.ok) throw classifyHttp(res.status, `${where}: HTTP ${res.status} ${await res.text()}`, res.headers.get("retry-after"));
      return (await res.json()) as { id: string };
    },
  };
}

export const email = createEmail({ baseURL: config.EMAIL_BASE_URL, timeoutMs: config.EMAIL_TIMEOUT_MS });
