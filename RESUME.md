# Resume point

## Status (16 Nov 2026)
Design route B is done except H5 and L5, which are deferred until the phases that need them.
Coding starts now.

Skill map: H1=2 H2=2 H3=2 H4=3 H5=1 | L1=1 L2=2 L3=2 L4=3 L5=0

Known weak spots: lock vs transaction; designing a schema from scratch; giving answers
without a "because". Prefer reasoning questions over recall.

## Build plan (each phase ends with a chaos test that proves it)

| Phase | Build | Chaos test |
|---|---|---|
| 0 | TypeScript repo layout, docker-compose (Postgres), schema applied, fake LLM server | `docker compose up` works; schema exists |
| 1 | Happy path: one hard-coded workflow runs end to end, results in memory | Runs to completion (baseline) |
| 2 | `events` + `@step` + replay from the start | Kill the worker at a random step 20 times; assert no finished step's LLM call repeats |
| 3 | Retries: transient vs permanent, backoff + jitter, Retry-After | Fake LLM returns 429 30% of the time; task still finishes |
| 4 | Outbox + dispatcher + fake email provider honouring idem_key | Kill between "decided to send" and "sent"; exactly one email |
| 5 | Leases, fencing token, polling, 3 workers | `kill -9` one worker mid-task; `kill -STOP` (freeze) one worker for 60 s, then `kill -CONT`; its stale writes must be rejected |
| 6 | Phoenix API: start task, approve/reject (one transaction) | Restart everything while WAITING_APPROVAL; approve; task resumes |
| 7 | Planner: LLM plans from a step registry; plan saved as step 1 | Crash at step 25; replay gets the identical plan |
| 7b | phoenix-tools (Python MCP server): calculate, analyze_table; `mcp_tool` step with allowlist | Kill the tools server mid-call: step retries; replay of a saved tool step makes zero MCP calls |
| 8 | Metrics: cost of recovery (re-spent tokens, duplicate emails, time lost) | Chart: naive retry vs Phoenix |

Do H5 (a rate limit shared across workers, retry and cost budgets) before phase 5.
Do L5 (deploying while tasks are in flight, logs and traces) before redeploying during runs.
Phase 9 (after building): clock skew, split brain, poison steps / DLQ, sagas, capacity sizing,
circuit breakers, versioning in depth, step granularity, Temporal / Restate / DBOS comparison.

## First prompt to give Claude Code
"Read CLAUDE.md, RESUME.md, docs/HLD.md and docs/LLD.md. We're starting phase 0.
Propose the repo layout and docker-compose, then wait for me before writing anything."
