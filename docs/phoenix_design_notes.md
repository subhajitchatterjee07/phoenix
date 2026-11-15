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
