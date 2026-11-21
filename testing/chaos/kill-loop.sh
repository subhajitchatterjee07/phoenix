#!/usr/bin/env bash
# Chaos 2, the phase 2 gate (PHX-022/023): one long task, one worker. KILLS times: wait a
# random 0.2-1 s, kill -9 the worker, restart it. Then wait for DONE and check that no
# FINISHED step was paid again. Usage: kill-loop.sh [KILLS=20] [SOURCES=200].
#
# Pass rules. The only call allowed to repeat is the step IN FLIGHT at a kill: its LLM call
# was made but the worker died before saving, so the restart must call it again. Steps run
# one at a time, so each crash wastes at most one call.
#   1. task DONE with all SOURCES+1 steps saved
#   2. every step called at least once
#   3. extra calls (total - steps) <= number of kills
# Two kills can land in the same in-flight step, so one step may be called 3+ times; that
# is still one wasted call per kill. Broken replay re-runs every saved step on each restart
# and blows far past rule 3.
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
    `${repeats.length} steps called more than once: ${JSON.stringify(Object.fromEntries(repeats))}`);
  const broken = [];
  if (+saved !== +process.argv[4] + 1) broken.push(`rule 1: ${saved} steps saved, expected ${+process.argv[4] + 1}`);
  if (mine.length !== +saved) broken.push(`rule 2: ${mine.length} steps called, ${saved} saved`);
  const extra = mine.reduce((a, [, n]) => a + n, 0) - mine.length;
  if (extra > +kills) broken.push(`rule 3: ${extra} extra LLM calls for only ${kills} kills`);
  if (broken.length) { console.log("FAIL: " + broken.join("; ")); process.exit(1); }
  console.log("PASS: chaos 2 (no finished step paid again)");' "$id" "$kills" "$saved" "$SOURCES"
