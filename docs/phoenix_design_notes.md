# Phoenix: design notes (running list for the HLD/LLD)

## Resume model: REPLAY FROM THE START (important)
After a crash, the new worker re-runs the task's workflow function from the top.
Every step that already has a row in `events` returns its saved result instantly
(no LLM call, no email). Execution continues normally from the first step with no row.

Why not just jump to the first missing step?
- The workflow keeps working data in memory (e.g. the list of 50 summaries that
  step 101 "write report" needs). A crash wipes that memory.
- Replaying steps 1..89 rebuilds those variables from the saved results in `events`,
  cheaply: each finished step is just a lookup.
- So workflow code can be written as an ordinary function; the @step wrapper does
  the crash-proofing.

Consequence (the determinism rule):
- Replay must make the same decisions in the same order as the first run.
- Anything unpredictable (LLM calls, now(), random(), API calls) must happen INSIDE
  a @step, so its result is saved once and replayed after that.
- Calling now()/random() in workflow code OUTSIDE a step can send a replay down a
  different branch than the original run.

## The @step contract (current version)
When step N of task T is called:
1. Look in `events` for (T, N). If a row exists, return the saved result. Run nothing.
2. Otherwise, run the actual function.
3. Save the result, ONLY IF tasks.fencing_token = my token AND the lease is live
   (one statement):
   - normal step: write the `events` row
   - side-effect step (email etc.): write the `events` row + `outbox` row in ONE transaction
   If rejected: stop working on T entirely, go back to the loop and claim another task.
4. Return the result.

Errors inside a step:
- Transient (timeout, 429, 5xx): retry with exponential backoff + jitter (use Retry-After if given).
- Permanent (404), or transient still failing after retries: record events.status = ERROR
  with `error` text, and the task continues.

Step lifecycle: (not reached) -> running, in memory only -> OK | ERROR (row committed).
A crash or rejected write while running leaves NO row: "unsaved = never happened".
No STARTED rows in `events`: they would give visibility, but replay would have to treat
them as not done (extra rule, extra write per step). Visibility comes from logs/traces (L5).

## Components (H2)
- Phoenix API (HTTP): the only door for humans. Start task (insert tasks PENDING); approve/reject
  (decisions + tasks back to PENDING in one transaction). Optional MCP adapter calls the API,
  never the DB, and never exposes Approve.
- Worker x N: long-running loop; claim task, run steps. Writes tasks (claim/lease/status),
  events, outbox (creates rows). Calls the LLM provider directly, inside @step.
- Dispatcher: sends PENDING outbox rows with idem_key, marks them SENT. Never touches tasks.
- Postgres: single source of truth. Blob storage: large step outputs.
- Boxes never call each other: they coordinate through Postgres rows (durable, independent
  failure, no addresses needed, one source of truth, retries via leases). Cost: up to one poll
  interval of latency; Postgres is the central dependency.

## Data flow of one email (H3)
1. Worker, step 81 inside @step: LLM call for the body, then ONE transaction (token current +
   lease live): events row (42, 81, OK) + outbox row (hash(42,81), Acme, body, PENDING).
2. Dispatcher: finds PENDING row, calls email provider with idem_key, marks row SENT.
3. Email provider delivers to Acme and drops repeats with the same key.

## Decisions so far
- Sequential steps inside a task; fan-out later.
- Keep fencing_token (monotonic, +1 per claim; guarded writes check my token + live lease).
- Lease 30 s, renew every 10 s; poll every ~5 s with jitter. Worst takeover ~ lease + poll.
- Claim guard is an allowlist: status IN ('PENDING','RUNNING').
- Single status column on tasks; human decisions in `decisions` (task_id, step_id).
- Approve = one transaction (insert decision + task back to PENDING, lease cleared).
- DONE when the last step commits; email delivery is tracked in outbox.status.
- Workers are long-running loops (claim -> run -> release -> claim next), not one pod per task.
- events.status (OK | ERROR) + error text: status for code, error for humans.
- Postgres as the queue (no RabbitMQ/Kafka for now). Reasons: one transaction can cover
  claim + events + outbox (a broker can't join a DB transaction: the dual-write problem);
  task state (leases, WAITING_APPROVAL for days, replay) has to live in the DB anyway;
  load is tiny (few long tasks), so polling is cheap; one less system to run.
  Revisit if: many short tasks, low-latency pickup, or fan-out to many consumers.
  Then: keep the outbox and add a relay that publishes outbox rows to the broker.
- One codebase, three entry points (api, worker, dispatcher), one Docker image.
  A modular monolith, not microservices: all three share one Postgres on purpose.
- Schema changes go through numbered migrations (PHX-006, 16 Nov 2026).
  `migrations/NNN_name.sql` files are applied in name order by `src/migrate.ts`
  (`npm run db:migrate`), and a `schema_migrations` table records which have run.
  Each file runs in ONE transaction with its `schema_migrations` row (a crash leaves
  all of it or none). A session advisory lock serialises migrators, so 3 workers
  booting together apply each file exactly once.
  Rejected: Postgres `docker-entrypoint-initdb.d` (runs only on an empty volume, so
  L5's `workflow_version` column could never reach an existing database);
  `CREATE TABLE IF NOT EXISTS` in one file (can't express ALTERs).
  Ordering at boot (PHX-010): a one-shot `migrate` compose service; api, worker and
  dispatcher wait for it with `condition: service_completed_successfully`, because
  `pg_isready` only means "accepting connections", not "schema ready".
- Configuration (PHX-007, 16 Nov 2026): LLD §9 values are env vars of the same name,
  validated with zod at boot; any bad value stops the process with every problem listed.
  Added to §9: `DATABASE_URL` (required) and the name `POLL_JITTER_MS` (§9 had only the value).
  LLM settings (base URL, key, model) are deferred to PHX-011.
- LLM client and fake (PHX-009, 16 Nov 2026): the official `openai` npm client talks to
  OpenRouter; the fake LLM speaks the same API, so switching between the fake and a real
  model (e.g. `deepseek/deepseek-chat`) is only a base URL + key + model change.
  Every LLM call sends `X-Phoenix-Task` and `X-Phoenix-Step` headers (OpenRouter ignores
  them) so the fake can count calls per (task, step); the chaos assertion "LLM calls per
  saved step = 1" reads `GET /stats`. Rejected: counting by a hash of the prompt (two
  steps with the same prompt would merge).
- Image and paths (PHX-010, 16 Nov 2026): one multi-stage Node image (`phoenix-app`)
  compiles `src/` and `testing/` to `dist/src` and `dist/testing`, so commands are
  `node dist/src/<box>.js`; `migrations/` is copied to `dist/migrations`. Inside compose,
  `DATABASE_URL` uses host `postgres`. Fake LLM listens on 9001 (HLD §8; PHX-009 had 8090
  by mistake).
- LLM client settings (PHX-011, 16 Nov 2026): `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
  default to the fake, so a paid model is only used when all three are set on purpose.
  The `openai` client runs with `maxRetries: 0`: its default would silently retry 429/5xx
  twice under our own step() retries (LLD §4.3), multiplying calls and hiding them from
  `events.attempts`. One retry layer, and it is ours.
- Seed script (PHX-012, 16 Nov 2026): `testing/seed.ts` (`npm run seed -- "<goal>"`)
  inserts a PENDING task straight into Postgres. DEV/TEST ONLY: it bypasses the API, which
  stays the product's only task writer (HLD §4). Needed until `POST /tasks` (PHX-043).
- Phase 1 workflow (PHX-013, 16 Nov 2026): `src/workflows.ts` `runTask` is hard-coded and
  naive on purpose: fetch → summarise each source → report, results only in memory.
  "fetch" reads `input.sources` (texts) from the task row; the real `fetch_page` (web) is
  phase 7. Step ids: 1 = fetch, 2..N+1 = summaries, N+2 = report.
- Phase 1 worker (PHX-014, 16 Nov 2026): `workOnce` = SELECT a PENDING task, UPDATE it to
  RUNNING, run, mark DONE. Naive on purpose: the SELECT→UPDATE gap lets two workers run
  the same task (test widens the ~1 ms gap to 50 ms to make it deterministic).
  TEMPORARY DEVIATION from LLD §3.1/§5.1: if the workflow throws, the task is marked
  FAILED with `failure_reason`, because with no leases yet "leave it alone" would mean
  RUNNING forever. Replaced by retries (phase 3) and lease expiry (phase 5).
- Large step results (PHX-017, 17 Nov 2026): LLD §2 sends results over
  `INLINE_RESULT_MAX_BYTES` (64 KB) to blob storage via `result_pointer`, but no blob store is
  designed yet. Until it is, `saveEvent` THROWS a clear error for such results (nothing in
  phases 2-4 produces them). Parked as PHX-064 on the board, to be designed later.
  `withTransaction(fn, db = pool)` takes an optional pool so tests can use a throwaway database.
- step() part 1 (PHX-018, 17 Nov 2026): `StepContext` gains optional `db` (tests only; the
  worker never sets it), added to LLD §4.1. Until PHX-019, `step()` only replays: a saved
  row is returned without calling `fn` (OK → value, ERROR → value); a step with no saved
  row throws "running new steps arrives in PHX-019". Nothing calls `step()` yet.
- step() part 2 (PHX-019, 17 Nov 2026): `fn` returns `StepOutput<T> = { value, tokens? }`
  so `step()` can save `events.tokens` (LLM steps pass `reply.tokens`; others omit it).
  If `fn` throws, nothing is saved and the error is rethrown (retries PHX-026, ERROR rows
  PHX-027). The first run returns the JSON round-tripped value (via canonicalJson), so it is
  identical to what replay returns; values JSON would change (Date, undefined) are rejected.
- Time and randomness (PHX-020, 17 Nov 2026): `now(ctx)` (epoch ms) and `random(ctx)` are
  plain functions in `step.ts`, not `ctx.now()` methods, so `StepContext` stays plain data.
  ESLint bans `Date.now()`, `new Date()` (no args), `Math.random()`, `crypto.randomUUID()`
  and `fetch` in `src/workflows.ts`; file I/O and MCP calls are left to review (rule 1).
- Porting the workflow (PHX-021, 17 Nov 2026): `fn(args, { stepId, signal })` so LLM steps
  can tag `X-Phoenix-Step` and pass the abort signal (LLD §4.3). Until the fencing guard
  (PHX-038), a duplicate key on save (another worker saved the step first) is thrown as
  `Fenced`, and the worker drops the task without changing its status (design rule 5).
  The phase 1 "fetch" (reading `input.sources`) is not a step: it is deterministic, so step
  ids are 1..N = summaries, N+1 = report.
- Chaos kill loop (PHX-022, 18 Nov 2026): the fake LLM's latency knob
  (`FAKE_LLM_LATENCY_MS`) is pulled forward from PHX-024 so tasks last long enough for a
  kill to land mid-task; the call is counted on arrival, so a call cut off by a kill still
  counts. Until leases (phase 5), the harness SIMULATES LEASE EXPIRY: after each kill it
  sets the task back to PENDING (test-only; no product code). First run: 20 kills on a
  201-step task → DONE, 220 LLM calls, 19 steps called exactly twice (the one in flight at
  each kill), no saved step ever paid again.
- Chaos 2 pass rules (PHX-023, 18 Nov 2026): the only LLM call allowed to repeat is the step
  IN FLIGHT at a kill (called, never saved). Steps run one at a time, so each crash wastes at
  most one call: (1) DONE with all steps saved, (2) every step called ≥ 1, (3) extra calls
  ≤ kills. A first "at most twice per step" rule was wrong: two kills can land in the same
  in-flight step (seen: 3 and 4 calls) while total extra calls stayed ≤ kills. Proven to
  fail on a broken replay (finished steps re-paid): 16 extra calls for 5 kills. Limit: one
  re-paid finished step could hide inside the allowance if some kills land during boot.
- Fake LLM faults (PHX-024, 18 Nov 2026): 429 (+ optional Retry-After), 500 and hang rates,
  set by env or at runtime via `POST /faults` so a chaos run can switch faults on without
  restarting the fake (which would reset its counters). Failed calls are counted too, so
  phase 3 can see retries in `/stats`.
- Error classification (PHX-025, 18 Nov 2026): each tool turns its failures into LLD §4.3
  types at its boundary, so `step()`'s retries only ask "transient or permanent?".
  429/408/5xx/timeout/connection → `TransientError` (429 carries `Retry-After`); other 4xx →
  `PermanentError`; our own aborted signal → `Fenced` (only a lost lease aborts it, so it is
  never retried). A 404 is permanent for the STEP, not the task. "LLM reply has no content"
  stays unclassified until real data says whether it is a glitch or a content filter.
- Retries (PHX-026, 18 Nov 2026): `runWithRetries` in `step.ts`, wired into `step()`.
  Full-jitter backoff per LLD §4.3; a 429's `Retry-After` replaces backoff but is CAPPED at
  `BACKOFF_CAP_MS` (30 s), so a provider saying "wait an hour" cannot stall the task: after
  5 attempts the step fails permanently instead. Only `TransientError` is retried. The wait
  is abortable (lease lost → `Fenced`). `events.attempts` now holds the real count.
