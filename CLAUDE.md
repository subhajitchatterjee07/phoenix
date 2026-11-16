# Project Phoenix

A durable, long-running AI agent. Given a goal, it plans steps from a fixed step registry, runs
them for hours, pauses for human approval (possibly for days), and sends emails, while surviving
`kill -9`, OOM kills, frozen workers, rate limits and redeploys at any point.

Success test: kill a worker at any moment, restart, and the task still finishes with no duplicate
emails, no re-paid LLM work for finished steps, and the same result.

## Read these first
- `docs/HLD.md`: components, promises, failure model, flows, key decisions
- `docs/LLD.md`: schema, state machines, @step contract, every query, dispatcher, API (build from this)
- `docs/PLAN_FORMAT.md`: how plans use loops and references (no hardcoded values)
- `docs/phoenix_design_notes.md`: the running decision log
- `migrations/001_init.sql`: DDL, generated from LLD section 2 (applied by `npm run db:migrate`)
- `docs/Phoenix_Components.png`, `docs/Phoenix_Task_State_Machine.png`
- `docs/Phoenix_Design_Dialogue*.pdf`: how and why the design was reached
- `RESUME.md`: where we are and what's next

## How I want to work (important)
- I am learning. I write the core logic myself; you guide, review and ask questions.
- Core logic I write: the @step wrapper, the claim/renew queries, guarded writes, the
  events+outbox transaction, the dispatcher loop, replay.
- You may write boilerplate when I ask: docker-compose, project setup, FastAPI wiring,
  the fake LLM server, the fake email provider, test harness scaffolding.
- When I'm stuck, teach Socratically (see the socratic-tutor skill if installed): one question
  at a time, narrow the question before giving answers, explain directly after 2-3 failed tries.
- Test my reasoning on new scenarios, not my recall of project details.
- Keep SQL examples short. Prefer small diagrams and concrete crash scenarios.
- I tend to work late. If it's past 1 am my time (IST), remind me once to stop.

## Non-negotiable design rules (from the design)
1. Anything unpredictable (LLM, now(), random(), HTTP/API calls, MCP tools) runs inside a @step.
2. Replay from the start; finished steps return their saved result from `events`.
3. Every worker write is guarded: tasks.fencing_token = my token AND lease live, same statement.
4. Side effects never happen directly in a step: events row + outbox row in ONE transaction;
   the dispatcher sends with idem_key = hash(task_id, step_id).
5. A rejected guarded write means: drop the task, go back to the loop.
6. Boxes (api, worker, dispatcher) never call each other; they coordinate through Postgres.
7. One codebase, three entry points, one Docker image. Postgres is the queue (no broker yet).
8. Claim guard is an allowlist: status IN ('PENDING','RUNNING').

## Stack
TypeScript (Node 22) for api, worker, dispatcher: `pg`, Fastify, zod, vitest,
`@modelcontextprotocol/sdk` (MCP client), OpenAI-compatible LLM client via OpenRouter.
Python MCP server `phoenix-tools` (separate container) for calculations and analytics.
Postgres 16, Docker Compose. Fake LLM and fake email servers to inject 429s, timeouts and crashes.

TypeScript-specific rules: `step()` is a wrapper function (no decorators); no Promise.all over
steps; no long synchronous CPU work in steps (it blocks the heartbeat; see LLD 4.4);
parse BIGINT columns from `pg` explicitly.
