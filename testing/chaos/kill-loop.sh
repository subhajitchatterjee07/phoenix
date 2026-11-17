#!/usr/bin/env bash
# Chaos loop (PHX-022): one long task, one worker. KILLS times: wait a random 0.2-1 s,
# kill -9 the worker, restart it. Then wait for DONE and print LLM calls per step.
# Usage: kill-loop.sh [KILLS=20] [SOURCES=200]. PHX-023 adds the pass/fail assertion.
#
# SIMULATED LEASE EXPIRY (test-only, until leases exist in phase 5): a killed worker leaves
# its task RUNNING and the naive worker only claims PENDING, so after each kill this script
# sets the task back to PENDING, the way an expired lease will make it claimable again.
set -euo pipefail
cd "$(dirname "$0")/../.."
KILLS=${1:-20}; SOURCES=${2:-200}
export FAKE_LLM_LATENCY_MS=${FAKE_LLM_LATENCY_MS:-100} # slow LLM: kills land mid-task
fail() { echo "FAIL: $*"; exit 1; }
sql() { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1' <<<"$1"; }

out=$(docker compose up -d --build --wait --scale worker=1 2>&1) || fail "compose up failed:\n$out"
curl -sf -X POST localhost:9001/reset >/dev/null
input=$(node -e 'console.log(JSON.stringify({ sources: Array.from({ length: +process.argv[1] }, (_, i) => `source ${i}`) }))' "$SOURCES")
id=$(sql "INSERT INTO tasks (goal, input) VALUES ('chaos kill loop', '$input') RETURNING task_id" | head -1)
echo "task $id: $SOURCES sources ($((SOURCES + 1)) LLM steps), $KILLS kills planned, LLM latency ${FAKE_LLM_LATENCY_MS} ms"

kills=0
for _ in $(seq 1 "$KILLS"); do
  sleep "$(node -e 'console.log((0.2 + Math.random() * 0.8).toFixed(2))')"
  [ "$(sql "SELECT status FROM tasks WHERE task_id = $id")" = DONE ] && { echo "task finished after $kills kills: use more sources"; break; }
  bash testing/chaos/kill.sh >/dev/null
  sql "UPDATE tasks SET status = 'PENDING', owner = NULL WHERE task_id = $id AND status = 'RUNNING'" >/dev/null
  docker compose start worker >/dev/null 2>&1
  kills=$((kills + 1))
done

for _ in $(seq 1 300); do
  status=$(sql "SELECT status FROM tasks WHERE task_id = $id")
  [ "$status" = DONE ] && break
  [ "$status" = FAILED ] && fail "task $id FAILED: $(sql "SELECT failure_reason FROM tasks WHERE task_id = $id")"
  sleep 1
done
[ "$status" = DONE ] || fail "task $id not DONE after the kills (status $status)"
saved=$(sql "SELECT count(*) FROM events WHERE task_id = $id")
curl -sf localhost:9001/stats | node -e '
  const s = JSON.parse(require("fs").readFileSync(0)); const [id, kills, saved] = process.argv.slice(1);
  const mine = Object.entries(s).filter(([k]) => k.startsWith(id + ":"));
  const repeats = mine.filter(([, n]) => n > 1);
  console.log(`task ${id} DONE after ${kills} kills: ${saved} steps saved, ${mine.reduce((a, [, n]) => a + n, 0)} LLM calls, ` +
    `${repeats.length} steps called more than once: ${JSON.stringify(Object.fromEntries(repeats))}`);' "$id" "$kills" "$saved"
