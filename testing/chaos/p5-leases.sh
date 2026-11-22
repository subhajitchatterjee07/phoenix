#!/usr/bin/env bash
# Chaos 5, the phase 5 gate (PHX-042). Real leases: nothing is fast-forwarded here.
#   A. kill -9 the worker running a task. Another worker takes it over (token +1) within
#      LIMIT_S, and the task finishes.
#   B. freeze (docker pause, freeze.sh) the worker running a task for 60 s. Another worker
#      takes it over within LIMIT_S; when the frozen one wakes, its writes are rejected (it
#      logs "dropped"), and no event carries its old token after the new owner's first event.
# Both: task DONE, every step saved, at most 1 extra LLM call (the step in flight at the crash).
set -euo pipefail
cd "$(dirname "$0")/../.."
LIMIT_S=38 # LEASE_SECONDS 30 + POLL_MS 5 + POLL_JITTER_MS 1 = 36 s worst case, + 2 s slack (D-36)
SOURCES=60 # 61 LLM steps
export FAKE_LLM_LATENCY_MS=${FAKE_LLM_LATENCY_MS:-1000} # ~61 s per task: still RUNNING under its new owner when the frozen worker wakes
fail() { echo "FAIL: $*"; exit 1; }
sql() { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1' <<<"$1"; }
wait_for() { # $1 = seconds, $2 = what, rest = a command that succeeds when done
  local secs=$1 what=$2; shift 2
  for _ in $(seq 1 "$secs"); do "$@" && return 0; sleep 1; done
  fail "timed out after $secs s waiting for $what"
}
has_steps() { [ "$(sql "SELECT count(*) FROM events WHERE task_id = $1")" -ge "$2" ]; }
token_above() { [ "$(sql "SELECT fencing_token FROM tasks WHERE task_id = $1")" -gt "$2" ]; }
is_done() { [ "$(sql "SELECT status FROM tasks WHERE task_id = $1")" = DONE ]; }
start_task() {
  local input; input=$(node -e 'console.log(JSON.stringify({ sources: Array.from({ length: +process.argv[1] }, (_, i) => `source ${i}`) }))' "$SOURCES")
  sql "INSERT INTO tasks (goal, input) VALUES ('$1', '$input') RETURNING task_id" | head -1
}
check_finished() { # $1 = task: DONE, all steps saved, at most 1 extra LLM call
  wait_for 120 "task $1 DONE" is_done "$1"
  [ "$(sql "SELECT count(*) FROM events WHERE task_id = $1")" = $((SOURCES + 1)) ] || fail "task $1: not every step saved"
  extra=$(curl -sf localhost:9001/stats | node -e 'const s = JSON.parse(require("fs").readFileSync(0));
    const n = Object.entries(s).filter(([k]) => k.startsWith(process.argv[1] + ":")).reduce((a, [, c]) => a + c, 0);
    console.log(n - process.argv[2])' "$1" $((SOURCES + 1)))
  [ "$extra" -le 1 ] || fail "task $1: $extra extra LLM calls (at most 1: the step in flight)"
}
takeover() { # $1 = task, $2 = old token: wait for the new claim, print seconds taken
  local t0; t0=$(date +%s)
  wait_for $((LIMIT_S + 5)) "a takeover of task $1" token_above "$1" "$2"
  local took=$(($(date +%s) - t0))
  [ "$took" -le "$LIMIT_S" ] || fail "task $1: takeover took $took s (limit $LIMIT_S s)"
  echo "$took"
}

out=$(docker compose up -d --build --wait 2>&1) || fail "compose up failed:\n$out"
curl -sf -X POST localhost:9001/reset >/dev/null

# A. kill -9 mid-task
a=$(start_task "chaos 5 kill")
wait_for 60 "task $a to save 3 steps" has_steps "$a" 3
read -r owner token <<<"$(sql "SELECT owner || ' ' || fencing_token FROM tasks WHERE task_id = $a")"
docker kill --signal KILL "$owner" >/dev/null
took=$(takeover "$a" "$token")
check_finished "$a"
echo "A. kill -9 $owner: task $a taken over in $took s (token $token -> $((token + 1))), DONE, extra calls $extra"
docker compose up -d --no-deps --scale worker=3 worker >/dev/null 2>&1 # replace the killed one

# B. freeze for 60 s mid-task
b=$(start_task "chaos 5 freeze")
wait_for 60 "task $b to save 3 steps" has_steps "$b" 3
read -r owner token <<<"$(sql "SELECT owner || ' ' || fencing_token FROM tasks WHERE task_id = $b")"
bash testing/chaos/freeze.sh 60 "$owner" >/dev/null &
took=$(takeover "$b" "$token")
wait # the 60 s freeze ends, the frozen worker wakes up
wait_for 30 "the woken worker to drop task $b" sh -c "docker logs $owner 2>&1 | grep -q 'task $b dropped'"
stale=$(sql "SELECT count(*) FROM events WHERE task_id = $b AND fencing_token = $token
  AND created_at > (SELECT min(created_at) FROM events WHERE task_id = $b AND fencing_token > $token)")
[ "$stale" = 0 ] || fail "task $b: $stale stale writes after the takeover"
check_finished "$b"
echo "B. froze $owner 60 s: task $b taken over in $took s; on waking it was fenced, 0 stale writes; DONE, extra calls $extra"
echo "PASS: phase 5 leases"
