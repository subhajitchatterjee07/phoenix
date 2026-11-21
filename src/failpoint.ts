import { config, type FAILPOINTS } from "./config.js";

/**
 * Chaos tests only: if CRASH_AT names this point, die exactly like `kill -9` (no finally
 * blocks, no exit handlers, no graceful pg close). Otherwise does nothing. Crashing once is
 * the chaos script's job: it restarts the process without CRASH_AT (decision D-26).
 */
export function failpoint(name: (typeof FAILPOINTS)[number], crashAt = config.CRASH_AT): void {
  if (name !== crashAt) return;
  console.error(`failpoint ${name}: SIGKILL`); // stderr to a pipe is synchronous on Linux, so this lands
  process.kill(process.pid, "SIGKILL");
}
