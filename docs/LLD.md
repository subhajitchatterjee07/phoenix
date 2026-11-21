# Phoenix: Low-Level Design

**Status:** v1.1, TypeScript core + Python tools server (16 Nov 2026) · **Read with:** `HLD.md`
Pseudocode is deliberately not final code: the core pieces (`step()`, guarded writes, the
outbox transaction, the dispatcher loop) are meant to be written by hand.

---

## 1. Stack and code layout

| Part | Choice |
|---|---|
| Core (api, worker, dispatcher) | Node 22 + TypeScript |
| Postgres client | `pg` (Pool, explicit transactions) |
| API | Fastify |
| Validation (plans, registry args, API bodies) | zod |
| LLM | official `openai` npm client pointed at OpenRouter (base URL, key, model configurable) |
| MCP client (in worker) | `@modelcontextprotocol/sdk` |
| Tools server | **Python** MCP server (`phoenix-tools`), Streamable HTTP transport: calculations, analytics |
| Tests | vitest |
| Runtime | Docker Compose, one Node image + one Python image |

```
phoenix/
  src/
    config.ts         # constants (§9)
    db.ts             # Pool, withTransaction(fn)
    migrate.ts        # applies migrations/*.sql in order (§2)
    queries.ts        # every SQL statement in §5, one function each
    step.ts           # step() wrapper, StepContext, errors (§4)
    registry.ts       # step types + zod arg schemas (§6)
    tools/
      llm.ts          # LLM client
      mcp.ts          # MCP client: allowlist, callTool (§6.3)
      web.ts          # search / fetch
    workflows.ts      # runTask(): plan → execute (§6)
    worker.ts         # entry: poll → claim → heartbeat → run → release (§5.1)
    dispatcher.ts     # entry: outbox loop (§7)
    api.ts            # entry: Fastify app (§8)
  migrations/         # 001_init.sql = DDL (§2); later changes are new numbered files
  tools-server/       # Python, separate image
    server.py         # MCP server: calculate, analyze_table, describe_stats ... (§6.3)
    pyproject.toml
  testing/
    fake-llm.ts       # injectable 429 / timeout / latency
    fake-email.ts     # honours Idempotency-Key, counts deliveries
    chaos/            # kill -9, kill -STOP/-CONT, restart scripts
  tests/
  docker-compose.yml
  Dockerfile          # Node image (api, worker, dispatcher)
```

---

## 2. Schema (Postgres 16)

```sql
CREATE TABLE tasks (
  task_id           BIGSERIAL PRIMARY KEY,
  goal              TEXT        NOT NULL,
  input             JSONB       NOT NULL DEFAULT '{}',   -- task data (e.g. list of schools); see PLAN_FORMAT.md
  status            TEXT        NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','RUNNING','WAITING_APPROVAL','DONE','FAILED')),
  owner             TEXT,                    -- worker id, NULL if unowned
  lease_expires_at  TIMESTAMPTZ,             -- NULL if unowned
  fencing_token     BIGINT      NOT NULL DEFAULT 0,   -- +1 on every claim, never reset
  max_steps         INT         NOT NULL DEFAULT 200,
  token_budget      BIGINT,                  -- NULL = unlimited
  tokens_used       BIGINT      NOT NULL DEFAULT 0,
  failure_reason    TEXT,                    -- set when FAILED
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the claim query's access path
CREATE INDEX tasks_claimable ON tasks (status, lease_expires_at)
  WHERE status IN ('PENDING','RUNNING');

CREATE TABLE events (                        -- append-only log of FINISHED steps
  task_id         BIGINT      NOT NULL REFERENCES tasks,
  step_id         INT         NOT NULL,      -- 1..N, assigned in call order
  step_type       TEXT        NOT NULL,      -- registry name, e.g. 'llm_summarize'
  input_hash      TEXT        NOT NULL,      -- sha256 of canonical args (replay sanity check)
  status          TEXT        NOT NULL CHECK (status IN ('OK','ERROR')),
  result_inline   JSONB,                     -- small results
  result_pointer  TEXT,                      -- blob key for large results
  error           TEXT,                      -- human-readable, NULL if OK
  attempts        INT         NOT NULL DEFAULT 1,
  tokens          INT         NOT NULL DEFAULT 0,
  fencing_token   BIGINT      NOT NULL,      -- which claim wrote it (audit)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, step_id)
);

CREATE TABLE outbox (
  idem_key        TEXT        PRIMARY KEY,   -- sha256('{task_id}:{step_id}')
  task_id         BIGINT      NOT NULL REFERENCES tasks,
  step_id         INT         NOT NULL,
  kind            TEXT        NOT NULL,      -- 'email' (later: 'slack', 'mcp_write', ...)
  guarantee       TEXT        NOT NULL CHECK (guarantee IN ('AT_LEAST_ONCE','AT_MOST_ONCE')),
  recipient       TEXT        NOT NULL,
  payload         JSONB       NOT NULL,      -- subject, body
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'PENDING';

-- H5: one row per external provider; every worker waits until `until` before calling it.
CREATE TABLE provider_cooldown (
  provider  TEXT        PRIMARY KEY,         -- 'llm' (the dispatcher keeps per-row backoff)
  until     TIMESTAMPTZ NOT NULL
);

CREATE TABLE decisions (
  task_id     BIGINT      NOT NULL REFERENCES tasks,
  step_id     INT         NOT NULL,          -- the request_approval step
  decision    TEXT        NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  decided_by  TEXT        NOT NULL,
  comment     TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, step_id)
);
```

Notes
- The DDL lives in `migrations/001_init.sql`; `src/migrate.ts` also creates
  `schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)` to record applied files.
  Schema changes are new numbered files, never edits to applied ones (design notes, PHX-006).
- `result_inline` vs `result_pointer`: store under ~64 KB inline, larger in blob storage.
- `input_hash` lets replay detect that a saved step was called with different arguments,
  which means non-determinism or a code change (throw, don't silently continue).
- `fencing_token` on `events` is audit only; the guard checks `tasks.fencing_token`.
- BIGINT comes back from `pg` as a string by default: parse ids and tokens explicitly
  (or set a type parser) so `token` comparisons in code don't silently compare strings.

---

## 3. State machines

### 3.1 Task
| From | To | Trigger | Written by | Guard |
|---|---|---|---|---|
| — | PENDING | task created | API | — |
| PENDING | RUNNING | claim | Worker | lease expired or NULL; token +1 |
| RUNNING | RUNNING | crash + takeover (owner, lease, token change) | Worker | lease expired; token +1 |
| RUNNING | WAITING_APPROVAL | approval step has no decision | Worker | my token; clears owner + lease |
| WAITING_APPROVAL | PENDING | approve | API | `status = 'WAITING_APPROVAL'` (one txn with decision) |
| WAITING_APPROVAL | FAILED | reject | API | same |
| RUNNING | DONE | last step committed | Worker | my token |
| RUNNING | FAILED | step limit / budget exceeded, or invalid plan | Worker | my token |

DONE and FAILED are final. Retries and takeovers never change the status.

### 3.2 Step (no row exists until it finishes)
```
not reached ──run──▶ running (memory only) ──commit──▶ OK
                             │                └──────▶ ERROR (permanent, recorded)
                             └─ crash / rejected write ──▶ no row ("never happened")
```

### 3.3 Outbox row
```
PENDING ──send ok──▶ SENT
   │ └─transient error──▶ PENDING (attempts+1, next_attempt_at = backoff)
   └─attempts exhausted / permanent error──▶ FAILED   (alert)
```

---

## 4. The `step()` contract

TypeScript decorators only work on class methods, so a step is a wrapper function call:

```ts
const summary = await step(ctx, "llm_summarize", { textRef: 7, focus: "pricing" },
                           (args) => llm.summarize(args));
```

### 4.1 Types
```ts
interface StepContext {
  taskId: number;
  token: number;              // fencing token from my claim
  nextStepId: number;         // starts at 1; +1 on every step() call, in call order
  signal: AbortSignal;        // aborted by the heartbeat if a renew returns 0 rows
  maxSteps: number;
  tokenBudget?: number | null; // from the claim; null = unlimited
  tokensUsed?: number;        // from the claim, + each newly saved step's tokens (one owner: exact)
  db?: pg.Pool;               // tests only: a throwaway database; defaults to the process pool
}

type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };  // recorded errors are values
type StepOutput<T> = { value: T; tokens?: number };  // what fn returns; tokens feed events.tokens + the budget
type StepMeta = { stepId: number; signal: AbortSignal };  // told to fn: header tag + abort
// step<A, T>(ctx, type, args: A, fn: (args: A, meta: StepMeta) => Promise<StepOutput<T>>): Promise<StepResult<T>>

class Suspend extends Error {}        // task paused (approval): stop executing
class Fenced extends Error {}         // my write was rejected: drop the task
class NonDeterminism extends Error {} // saved step replayed with different args
class LimitExceeded extends Error {}  // max_steps / token_budget reached: the worker FAILs the task
class PermanentError extends Error {}
class TransientError extends Error { constructor(msg: string, public retryAfterMs?: number) { super(msg) } }
```

### 4.2 Algorithm (every step)
```
stepId = ctx.nextStepId++
inputHash = sha256(canonicalJson({ type, args }))

1. row = SELECT ... FROM events WHERE task_id = ctx.taskId AND step_id = stepId
   if row:
       if row.input_hash !== inputHash: throw NonDeterminism
       return row as StepResult        // saved value or saved error

2. if ctx.signal.aborted: throw Fenced
   if stepId > ctx.maxSteps or ctx.tokensUsed >= ctx.tokenBudget: throw LimitExceeded
       (the worker writes the guarded FAILED with that reason, §5.6; D-33)

3. result = await runWithRetries(fn, args, ctx.signal)      // §4.3

4. save, guarded (§5.4 / §5.5):
     normal step:      INSERT events
     side-effect step: INSERT events + INSERT outbox, ONE transaction
                       (caller passes step(..., { outbox: value => row }); an ERROR outcome queues nothing)
   if 0 rows affected: throw Fenced

5. return result
```

### 4.3 Retries inside a step
| Error | Class | Action |
|---|---|---|
| timeout, ECONNRESET, MCP server unreachable | transient | retry |
| HTTP 429 | transient | wait `Retry-After` if present, else backoff |
| HTTP 5xx | transient | retry |
| HTTP 400/401/403/404/422, MCP tool error result | permanent | record ERROR, continue task |
| transient still failing after max attempts | permanent | record ERROR, continue task |
| HTTP 408 | transient | retry |
| our own `signal` aborted (lease lost) | `Fenced` | never retry; drop the task (rule 5) |

Backoff: `delay = Math.random() * Math.min(cap, base * 2 ** attempt)`, base 1 s, cap 30 s,
max 5 attempts. `Math.random()` here only affects timing, not results or branches, so it's safe.
`Retry-After` replaces the backoff for that wait but is capped at `BACKOFF_CAP_MS` (30 s), so one
step never stalls a task for long; a wait is cut short by an aborted signal (→ `Fenced`).
`step()` saves the attempt count in `events.attempts`.

**Shared cool-down (H5).** The provider's limit is per API key, not per worker, so three
workers each backing off politely still add up. Before every LLM attempt, `runWithRetries`
waits until `provider_cooldown.until` for `'llm'` (one indexed read; abortable → `Fenced`).
On a 429 or 5xx it pushes the cool-down forward, never back:
```sql
INSERT INTO provider_cooldown (provider, until) VALUES ('llm', now() + $ms * interval '1 millisecond')
ON CONFLICT (provider) DO UPDATE SET until = GREATEST(provider_cooldown.until, EXCLUDED.until);
```
with `$ms` = `Retry-After` (capped) or `backoffMs(n)`. All times are the database's clock.
- **A 429 does not use an attempt:** the provider did no work and said "later". 5xx, 408 and
  timeouts still count toward the 5. Waiting never counts.
- **Bounded:** if a step has spent more than `OVERLOAD_MAX_WAIT_MS` (15 min) waiting on 429s,
  it gives up as a permanent failure ("provider overloaded for N min"), recorded as ERROR.
- **Retry budget:** the shared cool-down is the budget. While it holds, no worker sends
  anything, so retries can't pile onto an overloaded provider.
- The heartbeat keeps renewing the lease while a step waits (§5.3).
Pass `ctx.signal` to `fetch` and to the LLM/MCP clients so a fenced worker stops waiting.
Classification happens at each tool's boundary: `classifyHttp(status, message, retryAfter)` in
`step.ts` (seconds or HTTP-date `Retry-After`); `tools/llm.ts` maps the `openai` client's errors.

### 4.4 Event loop rule (TypeScript-specific)
The heartbeat is a `setInterval` on the **same event loop** as the steps. Synchronous
CPU-heavy work (parsing a huge page, big JSON transforms) blocks it, renewals stop, the lease
expires, and your own worker becomes the "frozen worker". The fencing token keeps data safe,
but the task gets taken over for no reason. Rule: no long synchronous work in steps; move it
to `worker_threads` or to the Python tools server.

### 4.5 Determinism rules for workflow code
- No `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, `fetch`, file I/O or
  MCP calls outside a step. Use `await now(ctx)` / `await random(ctx)` from `step.ts` (tiny
  built-in steps). ESLint enforces the ban in `src/workflows.ts` (file I/O and MCP: review).
- `Promise.all` over steps is not allowed in v1 (step ids must be assigned in a fixed order).
- Don't iterate over unordered data to decide which steps to run (sort first).
- Don't change the order of steps for tasks already in flight (L5).

### 4.6 Approval step
```
requestApproval(ctx, summaryStepId):           // registry step
  d = SELECT decision FROM decisions WHERE task_id, step_id
  if !d:
      guarded UPDATE tasks SET status='WAITING_APPROVAL', owner=NULL, lease_expires_at=NULL
      throw Suspend                            // worker stops this task, back to its loop
  save events row with d (guarded), return d
  // REJECTED never reaches here: the API set the task to FAILED
```

---

## 5. Queries (in `queries.ts`)

`$me` = worker id, `$tok` = my fencing token.

### 5.1 Worker loop
```
while (true) {
  task = await claim()                                   // 5.2
  if (!task) { await sleep(5000 ± 1000); continue }
  controller = new AbortController()
  stop = startHeartbeat(task, controller)   // 5.3: renew every 10 s; abort on 0 rows or a full lease without a renew
  try   { await runTask(ctx); await markDone() }         // 5.6
  catch (e) {
    if (e instanceof Suspend) {}                         // already paused
    else if (e instanceof Fenced) log("fenced off", taskId)
    else throw-or-log (unexpected: leave task; lease expiry hands it to another worker)
  } finally { clearInterval(hb) }
}
```

### 5.2 Claim (atomic, one winner)
```sql
UPDATE tasks
SET owner = $me, status = 'RUNNING',
    fencing_token = fencing_token + 1,
    lease_expires_at = now() + interval '30 seconds', updated_at = now()
WHERE task_id = (
  SELECT task_id FROM tasks
  WHERE status IN ('PENDING','RUNNING')
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING task_id, fencing_token, goal, input, max_steps;
```
Note `lease_expires_at IS NULL`: PENDING tasks have no lease, and `NULL < now()` is not true.
Implemented as `claim(me)` in `queries.ts` (PHX-036): the interval is `LEASE_SECONDS`, and
`input` is returned too (the workflow needs it). Without `SKIP LOCKED` a claimer waits for
the in-flight claim to commit, then moves on: correct but serialized. Without `FOR UPDATE`
at all, two claimers can both win the same task.

### 5.3 Renew
```sql
UPDATE tasks SET lease_expires_at = now() + interval '30 seconds'
WHERE task_id = $id AND fencing_token = $tok AND status = 'RUNNING';
-- 0 rows → I no longer own it → abort
```
Heartbeat (`startHeartbeat` in `heartbeat.ts`, PHX-037): every `HEARTBEAT_MS`, each renew
scheduled only after the previous one finished (chained `setTimeout`, never two in flight).
- 0 rows: abort with `Fenced`, at once.
- The renew throws (database unreachable, blip): log it and try again next beat. A full
  `LEASE_SECONDS` without one successful renew (our clock): abort, since another worker may
  own the task by now and our steps' saves would be rejected (PHX-038) anyway (D-31).

### 5.4 Guarded save (normal step)
```sql
INSERT INTO events (task_id, step_id, step_type, input_hash, status,
                    result_inline, result_pointer, error, attempts, tokens, fencing_token)
SELECT $id, $step, $type, $hash, $status, $inline, $ptr, $err, $attempts, $tokens, $tok
WHERE EXISTS (SELECT 1 FROM tasks
              WHERE task_id = $id AND fencing_token = $tok
                AND lease_expires_at > now() AND status = 'RUNNING');
-- rowCount 0 → throw Fenced
```
Same transaction: `UPDATE tasks SET tokens_used = tokens_used + $tokens WHERE ... (guarded)`.

As built (PHX-038, D-32): the guarded `tokens_used` UPDATE runs **first** in `saveEvent`'s
transaction and is the guard for the whole save. It checks `fencing_token = $tok AND
lease_expires_at > now() AND status = 'RUNNING'`; on 0 rows → ROLLBACK, `saveEvent` returns
false, `step()` throws `Fenced`. The UPDATE row-locks the task until COMMIT, so a concurrent
claim (which must UPDATE the same row) waits, and the token can't change between the guard and
the events/outbox inserts. That is why the check sits in a write that locks, not in a read before it.

### 5.5 Guarded save (side-effect step): one transaction
```
BEGIN
  INSERT INTO events ... (as 5.4)          -- rowCount 0: ROLLBACK, throw Fenced
  INSERT INTO outbox (idem_key, task_id, step_id, kind, guarantee, recipient, payload)
  VALUES (sha256(`${id}:${step}`), ...)
COMMIT
```

### 5.6 Done / fail (guarded)
```sql
UPDATE tasks SET status = 'DONE', owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE task_id = $id AND fencing_token = $tok AND status = 'RUNNING';
```
FAILED (budget, invalid plan) is the same with `status = 'FAILED', failure_reason = $why`.

### 5.7 Approve / reject (API): one transaction
```
BEGIN
  INSERT INTO decisions (task_id, step_id, decision, decided_by, comment) VALUES (...)
  UPDATE tasks SET status = CASE WHEN $decision = 'APPROVED' THEN 'PENDING' ELSE 'FAILED' END,
                   updated_at = now()
  WHERE task_id = $id AND status = 'WAITING_APPROVAL'
  -- rowCount 0 → ROLLBACK, 409 Conflict (double click, wrong state)
COMMIT
```

---

## 6. Planner, registry and tools

### 6.1 Registry (zod)
```ts
export const REGISTRY = {
  web_search:       { args: z.object({ query: z.string() }),                       sideEffect: null },
  fetch_page:       { args: z.object({ url: z.string().url() }),                   sideEffect: null },
  llm_summarize:    { args: z.object({ textRef: z.number(), focus: z.string() }),  sideEffect: null },
  calculate:        { args: z.object({ expression: z.string() }),                  sideEffect: null },
  analyze_data:     { args: z.object({ dataRef: z.number(), question: z.string() }), sideEffect: null },
  mcp_tool:         { args: z.object({ server: z.string(), tool: z.string(), input: z.record(z.unknown()) }),
                      sideEffect: null },          // read-only tools only (allowlist, §6.3)
  write_report:     { args: z.object({ fromSteps: z.array(z.number()) }),          sideEffect: null },
  request_approval: { args: z.object({ reportStep: z.number() }),                  sideEffect: null },
  send_email:       { args: z.object({ to: z.string().email(), brief: z.string(),
                                       guarantee: z.enum(["AT_LEAST_ONCE","AT_MOST_ONCE"]) }),
                      sideEffect: "email" },
} as const;

const PlanItem = z.object({ type: z.enum(Object.keys(REGISTRY) as [string, ...string[]]),
                            args: z.unknown() });
const Plan = z.array(PlanItem).max(200);
```

### 6.2 Workflow (plan templates, loops and references: see `PLAN_FORMAT.md`)
```ts
async function runTask(ctx: StepContext) {
  const plan = await step(ctx, "make_plan", { goal: ctx.goal }, makePlan);  // step 1: LLM → Plan
  validatePlan(plan);              // zod: Plan + each item's args against REGISTRY[type].args
  for (const item of plan) await runRegisteredStep(ctx, item);              // each is a step()
}
```
- The plan is step 1's saved result, so replay gets the identical plan.
- Invalid plan → task FAILED with `failure_reason`.
- Agent-loop variant (later): each "decide the next step" call is its own `step()`.
- `calculate` and `analyze_data` are thin wrappers over `mcp_tool` calls to `phoenix-tools`.

### 6.3 Tools server (Python, MCP)
A separate process and container, `phoenix-tools`, built with the official Python MCP SDK,
exposed over Streamable HTTP inside the compose network.

| Tool | Does | Notes |
|---|---|---|
| `calculate` | Evaluate a maths expression safely | No `eval`; use a safe evaluator (e.g. `simpleeval` or `sympy` parsing) |
| `analyze_table` | pandas over a dataset fetched by an earlier step | Input is a reference/URL, not huge inline data |
| `describe_stats` | mean, median, percentiles, correlations | |
| `query_analytics` | Read-only SQL on an analytics DB | Read-only DB user; statement timeout |

Rules
1. **Called only inside `step()`.** Its results are saved like an LLM result; replay never
   calls the server again for a saved step.
2. **Read-only tools only** through `mcp_tool`. A tool that changes the outside world (post to
   Slack, write a row) is a side effect: it gets its own registry type that writes an outbox row,
   and the dispatcher performs it.
3. **Allowlist** in `tools/mcp.ts`: `{ server → [tools] }`. Anything else → PermanentError.
4. **Stateless.** The tools server keeps no state between calls (inputs carry everything),
   so restarting it is always safe.
5. This is a direct worker → server call, an allowed exception to "components never call each
   other" (same as the LLM provider): the worker needs the answer now, and `step()` handles failures.
6. Third-party MCP servers can be added to the allowlist the same way.

---

## 7. Dispatcher

```
while (true) {
  row = (in a transaction) SELECT * FROM outbox
        WHERE status = 'PENDING' AND next_attempt_at <= now()
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  if (!row) { await sleep(2000); continue }
  try {
    await emailProvider.send(row.recipient, row.payload, { idempotencyKey: row.idem_key })
    UPDATE outbox SET status='SENT', sent_at=now(), attempts=attempts+1 WHERE idem_key=$k
  } catch (e) {
    transient → UPDATE outbox SET attempts=attempts+1, last_error=$e,
                next_attempt_at = now() + backoff(attempts) WHERE idem_key=$k
                (→ FAILED when attempts ≥ 8)
    permanent → UPDATE outbox SET status='FAILED', last_error=$e WHERE idem_key=$k
  }
}
```
- `backoff(attempts)` = `backoffMs()` in `step.ts`, the step-retry formula and config (§4.3):
  full jitter, base 1 s, cap 30 s, a 429's `Retry-After` wins but is capped. An error that is
  neither transient nor permanent counts as transient (still FAILED after 8).
- AT_MOST_ONCE rows (only for providers without idempotency keys): mark SENT and COMMIT
  before calling the provider, never retry; if the send throws, set FAILED + `last_error`.
- The dispatcher never reads or writes `tasks`.

---

## 8. Phoenix API (Fastify, zod-validated bodies)

| Method | Path | Does |
|---|---|---|
| POST | `/tasks` | body `{ goal, maxSteps?, tokenBudget? }` → insert PENDING → `201 { taskId }` |
| GET | `/tasks/:id` | status, failureReason, tokensUsed |
| GET | `/tasks/:id/steps` | events rows (results, errors) |
| GET | `/tasks/:id/outbox` | delivery status of side effects |
| POST | `/tasks/:id/steps/:step/approve` | §5.7 with APPROVED → `200` or `409` |
| POST | `/tasks/:id/steps/:step/reject` | §5.7 with REJECTED |

The API never writes `events` or `outbox`. An MCP adapter for AI assistants, if added, calls
these endpoints and does not expose approve/reject.

---

## 9. Configuration

Every value is an environment variable of the same name, validated at boot by `src/config.ts`.

| Name | Default |
|---|---|
| `DATABASE_URL` | required, no default |
| `LEASE_SECONDS` | 30 |
| `HEARTBEAT_MS` | 10000 |
| `POLL_MS` / `POLL_JITTER_MS` | 5000 / ±1000 |
| `STEP_MAX_ATTEMPTS` | 5 |
| `BACKOFF_BASE_MS` / `BACKOFF_CAP_MS` | 1000 / 30000 |
| `OUTBOX_MAX_ATTEMPTS` | 8 |
| `OVERLOAD_MAX_WAIT_MS` | 900000 (15 min): how long one step may wait on 429s before giving up (H5) |
| `DEFAULT_MAX_STEPS` | 200 |
| `INLINE_RESULT_MAX_BYTES` | 65536 |
| `LLM_TIMEOUT_MS` | 60000 |
| `EMAIL_BASE_URL` / `EMAIL_TIMEOUT_MS` | the fake: `http://localhost:9002` (compose: `http://fake-email:9002`) / 10000. `POST {base}/emails`, body `{ to, subject, body }`, header `Idempotency-Key`. The timeout also bounds how long the dispatcher holds an outbox row lock |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | the fake: `http://localhost:9001/v1` / `fake` / `fake` (compose: `http://fake-llm:9001/v1`). Real: `https://openrouter.ai/api/v1` / your key / e.g. `deepseek/deepseek-chat` |
| `MCP_TOOLS_URL` | `http://phoenix-tools:8100/mcp` |
| `MCP_ALLOWLIST` | `{ "phoenix-tools": ["calculate","analyze_table","describe_stats","query_analytics"] }` |
| `CRASH_AT` | unset. Chaos tests only: one of `between_event_and_outbox`, `after_outbox_commit`, `after_send_before_sent` (an unknown name fails at boot) |

---

## 10. Testing hooks

| Tool | Purpose |
|---|---|
| `fake-llm` | OpenRouter drop-in at `http://localhost:${FAKE_LLM_PORT:-9001}/v1`; deterministic answers; counts calls per (task, step) from the `X-Phoenix-Task` / `X-Phoenix-Step` headers; `GET /stats`, `POST /reset`. Fault knobs (rates 0..1 rolled per call; every call counted on arrival, failed ones too): `FAKE_LLM_LATENCY_MS`, `FAKE_LLM_429_RATE` + `FAKE_LLM_RETRY_AFTER_S`, `FAKE_LLM_5XX_RATE`, `FAKE_LLM_HANG_RATE` (never answers, so the caller times out); changeable at runtime via `GET`/`POST /faults` |
| `fake-email` | `POST /emails` at `http://localhost:${FAKE_EMAIL_PORT:-9002}`, body `{ to, ... }`, header `Idempotency-Key` (required, else 400). First send with a key delivers and returns `{ id }`; same key + same body returns the original `{ id }` and delivers nothing; same key + different body → 409. `GET /stats` → `{ key: { requests, deliveries } }`, `POST /reset`. No fault knobs yet |
| `failpoint(name)` (`src/failpoint.ts`) | If `CRASH_AT` equals `name`, the process SIGKILLs itself there (a real `kill -9`: no finally, no exit handlers). Points: `between_event_and_outbox`, `after_outbox_commit` (PHX-031), `after_send_before_sent` (PHX-032). The chaos script makes it fire once: start with `CRASH_AT`, wait for exit 137, restart without it |
| `chaos/kill.sh` | `kill -9` a random worker at a random time |
| `chaos/kill-loop.sh` | `npm run chaos:kill -- KILLS SOURCES`: one long task, kill + restart the worker KILLS times, wait for DONE, print LLM calls per step. Until leases (phase 5) it simulates lease expiry by setting the task back to PENDING |
| `chaos/freeze.sh` | `kill -STOP` a worker for N s, then `kill -CONT` |
| `chaos/block-loop` | A test step that blocks the event loop for 40 s (reproduces §4.4) |
| Assertions | Chaos 2: task DONE with every step saved; every step called ≥ 1; extra LLM calls ≤ kills (only the step in flight at a crash may repeat). Chaos 3 (`chaos/p3-ratelimit.sh`, 30% 429s): no task stuck; DONE, or FAILED only by a 5-attempt give-up; every ERROR row is such a give-up; some OK step has attempts > 1; per step, LLM calls ≥ saved attempts. Chaos 4 (`chaos/p4-outbox.sh`): crash at each failpoint (worker: `between_event_and_outbox` leaves no rows, `after_outbox_commit` leaves event + 1 outbox row; dispatcher: `after_send_before_sent`); then all tasks DONE, one outbox row per task, all SENT, provider keys = outbox keys, each delivered once, ≥ 1 resent and deduped. Takeover ≤ 35 s (phase 5) |

---

## 11. Open (to design later)
- ~~H5~~: decided 22 Nov 2026, a shared cool-down (§4.3). A token bucket (a hard requests-per-minute
  cap) is the next step if real provider limits need it; a global daily cost cap likewise.
- L5: `workflow_version` pinned on `tasks` at creation; workers run the matching code version.
- L5: structured logs with `taskId`, `stepId`, `fencingToken`; traces across takeovers;
  alerts for RUNNING tasks without progress and PENDING outbox rows older than N minutes.
