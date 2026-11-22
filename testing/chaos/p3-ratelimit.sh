#!/usr/bin/env bash
# Phase 3 (Chaos 3): the fake LLM answers 429 to 30% of calls; every task still finishes.
# Since PHX-067 (H5) a 429 doesn't use one of a step's attempts (the provider did no work);
# only OVERLOAD_MAX_WAIT_MS (15 min) of 429s would end a step. So in this short run nothing
# may give up: every task DONE, no ERROR rows. (Before PHX-067, D-24 allowed honest give-ups.)
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

# 1-2. No give-ups: every task DONE, no ERROR rows.
[ "$(sql "SELECT count(*) FROM tasks WHERE task_id >= $first AND status <> 'DONE'")" = 0 ] || fail "a task did not end DONE"
[ "$(sql "SELECT count(*) FROM events WHERE task_id >= $first AND status = 'ERROR'")" = 0 ] || fail "a step gave up"
# 3-4. Every saved attempt was a real call (calls >= attempts per step), and the 429s were
#    retried without counting: some step made more calls than its saved attempts.
rows=$(sql "SELECT task_id || ':' || step_id || ':' || attempts FROM events WHERE task_id >= $first")
summary=$(curl -sf localhost:9001/stats | node -e '
  const stats = JSON.parse(require("fs").readFileSync(0));
  let calls = 0, attempts = 0, retried = 0;
  for (const row of process.argv[1].split("\n")) {
    const [task, step, n] = row.split(":");
    if ((stats[`${task}:${step}`] ?? 0) < Number(n)) { console.log(`${task}:${step}`); process.exit(1); }
    calls += stats[`${task}:${step}`]; attempts += Number(n); retried += stats[`${task}:${step}`] > Number(n);
  }
  if (retried === 0) { console.log("none: were the 429s retried?"); process.exit(1); }
  console.log(`${calls} LLM calls, ${attempts} attempts saved, ${retried} steps retried after a 429`);' "$rows") \
  || fail "calls vs attempts: $summary"

counts=$(sql "SELECT count(*) FILTER (WHERE status = 'DONE') || ' DONE, ' || count(*) FILTER (WHERE status = 'FAILED') || ' FAILED'
  FROM tasks WHERE task_id >= $first")
echo "20 tasks: $counts; $summary"
echo "PASS: phase 3 rate limits"
