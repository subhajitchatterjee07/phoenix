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
  MCP_TOOLS_URL: z.url().default("http://phoenix-tools:8100/mcp"),
  MCP_ALLOWLIST: allowlist.default({
    "phoenix-tools": ["calculate", "analyze_table", "describe_stats", "query_analytics"],
  }),
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
