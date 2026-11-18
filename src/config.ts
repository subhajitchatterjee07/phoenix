import { z } from "zod";

// LLD §9. Every value can be overridden by an environment variable of the same name.
const positiveInt = () => z.coerce.number().int().positive();

const allowlist = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string(), z.array(z.string())));

/** Named crash points (PHX-030). Placed by PHX-031 (outbox) and PHX-032 (dispatcher). */
export const FAILPOINTS = ["between_event_and_outbox", "after_outbox_commit", "after_send_before_sent"] as const;

const ConfigSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must start with postgres://"),
  LEASE_SECONDS: positiveInt().default(30),
  HEARTBEAT_MS: positiveInt().default(10_000),
  POLL_MS: positiveInt().default(5_000),
  POLL_JITTER_MS: positiveInt().default(1_000),
  STEP_MAX_ATTEMPTS: positiveInt().default(5),
  BACKOFF_BASE_MS: positiveInt().default(1_000),
  BACKOFF_CAP_MS: positiveInt().default(30_000),
  OUTBOX_MAX_ATTEMPTS: positiveInt().default(8),
  DEFAULT_MAX_STEPS: positiveInt().default(200),
  INLINE_RESULT_MAX_BYTES: positiveInt().default(65_536),
  LLM_TIMEOUT_MS: positiveInt().default(60_000),
  // Defaults point at the fake LLM: a real, paid model needs all three set explicitly.
  LLM_BASE_URL: z.url().default("http://localhost:9001/v1"),
  LLM_API_KEY: z.string().min(1).default("fake"),
  LLM_MODEL: z.string().min(1).default("fake"),
  MCP_TOOLS_URL: z.url().default("http://phoenix-tools:8100/mcp"),
  MCP_ALLOWLIST: allowlist.default({
    "phoenix-tools": ["calculate", "analyze_table", "describe_stats", "query_analytics"],
  }),
  // Chaos tests only. A closed list, so a typo fails at boot instead of never firing.
  // Empty means unset (compose passes `${CRASH_AT:-}`).
  CRASH_AT: z.preprocess((v) => (v === "" ? undefined : v), z.enum(FAILPOINTS).optional()),
});

export type Config = Readonly<z.infer<typeof ConfigSchema>>;

/** Throws one error listing every bad variable, so a misconfigured box fails at boot. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return Object.freeze(result.data);
}

export const config: Config = loadConfig(process.env);
