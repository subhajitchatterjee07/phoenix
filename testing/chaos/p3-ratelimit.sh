#!/usr/bin/env bash
# Phase 3 (Chaos 3): the fake LLM answers 429 to 30% of calls; every task still finishes.
# A 429 is transient: retried with backoff. Five in a row (0.3^5 = 0.24% of calls) is a give-up:
# saved as ERROR with attempts = 5, and the task goes on. Only a give-up on the report step
# fails a task. Pass rule (D-24): an honest give-up passes; a stuck task or any other failure doesn't.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "FAIL: $*"; exit 1; }
sql() { docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }
faults() { curl -sf -X POST -H 'content-type: application/json' -d "$1" localhost:9001/faults >/dev/null; }

out=$(docker compose up -d --build --wait 2>&1) || fail "compose up failed:\n$out"
curl -sf -X POST localhost:9001/reset >/dev/null
trap 'faults "{\"rate429\":0}" || true' EXIT # never leave the stack rate limited
faults '{"rate429":0.3,"retryAfterS":null}' # no Retry-After: exercises the backoff path

first=$(sql "INSERT INTO tasks (goal, input) SELECT 'ratelimit ' || g, '{\\\"sources\\\":[\\\"a\\\",\\\"b\\\",\\\"c\\\"]}'
  FROM generate_series(1, 20) g RETURNING task_id" | head -1)
for i in $(seq 1 180); do
  [ "$(sql "SELECT count(*) FROM tasks WHERE task_id >= $first AND status IN ('PENDING','RUNNING')")" = 0 ] && break
  [ "$i" = 180 ] && fail "tasks from id $first not finished after 180 s"
  sleep 1
done

# 1. Every task DONE, or FAILED only because its report step gave up.
bad=$(sql "SELECT count(*) FROM tasks WHERE task_id >= $first AND status <> 'DONE'
  AND NOT (status = 'FAILED' AND failure_reason LIKE '%gave up after 5 attempts%')")
[ "$bad" = 0 ] || fail "$bad task(s) failed for a reason other than an honest give-up"
# 2. The only ERROR rows are give-ups, saved with all 5 attempts.
[ "$(sql "SELECT count(*) FROM events WHERE task_id >= $first AND status = 'ERROR'
  AND (attempts <> 5 OR error NOT LIKE 'gave up after 5 attempts%')")" = 0 ] || fail "an ERROR event is not a 5-attempt give-up"
# 3. Retries really happened and were recorded: an OK step with attempts > 1 (a give-up row
#    always has 5, so it must not count).
retried=$(sql "SELECT count(*) FROM events WHERE task_id >= $first AND status = 'OK' AND attempts > 1")
[ "$retried" -gt 0 ] || fail "no OK step has attempts > 1: were the 429s retried?"
# 4. Every saved attempt was a real call: per step, fake LLM calls >= events.attempts.
#    (More is allowed: the naive claim can run a step twice until PHX-036.)
rows=$(sql "SELECT task_id || ':' || step_id || ':' || attempts FROM events WHERE task_id >= $first")
summary=$(curl -sf localhost:9001/stats | node -e '
  const stats = JSON.parse(require("fs").readFileSync(0));
  let calls = 0, attempts = 0;
  for (const row of process.argv[1].split("\n")) {
    const [task, step, n] = row.split(":");
    if ((stats[`${task}:${step}`] ?? 0) < Number(n)) { console.log(`${task}:${step}`); process.exit(1); }
    calls += stats[`${task}:${step}`]; attempts += Number(n);
  }
  console.log(`${calls} LLM calls, ${attempts} attempts saved`);' "$rows") || fail "step $summary saved more attempts than calls"

counts=$(sql "SELECT count(*) FILTER (WHERE status = 'DONE') || ' DONE, ' || count(*) FILTER (WHERE status = 'FAILED') || ' FAILED'
  FROM tasks WHERE task_id >= $first")
gaveup=$(sql "SELECT count(*) FROM events WHERE task_id >= $first AND status = 'ERROR'")
echo "20 tasks: $counts; $retried steps recovered by retrying, $gaveup gave up; $summary"
echo "PASS: phase 3 rate limits"
