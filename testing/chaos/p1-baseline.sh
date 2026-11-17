#!/usr/bin/env bash
# Phase 1 baseline (Chaos 1): the full stack runs tasks to DONE. Records LLM calls, so later
# phases have a "before" number. Naive workers can run a task twice; that is RECORDED here,
# not failed on. "Exactly once" is enforced from phase 2 (PHX-023) and phase 5 (PHX-036).
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "FAIL: $*"; exit 1; }
sql() { docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }
stats() { curl -sf localhost:9001/stats; }
reset_llm() { curl -sf -X POST localhost:9001/reset >/dev/null; }
seed() { sql "INSERT INTO tasks (goal, input) SELECT 'baseline ' || g, '{\\\"sources\\\":[\\\"a\\\",\\\"b\\\",\\\"c\\\"]}'
  FROM generate_series(1, $1) g RETURNING task_id" | head -1; }
wait_done() { # $1 = first task id, $2 = timeout seconds
  for _ in $(seq 1 "$2"); do
    [ "$(sql "SELECT count(*) FROM tasks WHERE task_id >= $1 AND status IN ('PENDING','RUNNING')")" = 0 ] && return 0
    sleep 1
  done
  fail "tasks from id $1 not finished after $2 s"
}

out=$(docker compose up -d --build --wait 2>&1) || fail "compose up failed:\n$out"

# Part 1: one task, 3 idle workers.
reset_llm
id=$(seed 1)
wait_done "$id" 60
[ "$(sql "SELECT status FROM tasks WHERE task_id = $id")" = DONE ] || fail "task $id did not end DONE"
counts=$(stats | node -e 'const s=JSON.parse(require("fs").readFileSync(0));
  const c=[2,3,4,5].map(n=>s[process.argv[1]+":"+n]??0); if(c.some(x=>x<1)) process.exit(1); console.log(c.join(","))' "$id") \
  || fail "task $id: some LLM step was never called"
echo "single task $id: DONE, LLM calls per step 2..5 = $counts"

# Part 2: 50 tasks queued, 3 workers started together (the naive race).
docker compose stop worker >/dev/null 2>&1
reset_llm
first=$(seed 50)
docker compose up -d --no-deps --scale worker=3 worker >/dev/null 2>&1
wait_done "$first" 120
done_count=$(sql "SELECT count(*) FROM tasks WHERE task_id >= $first AND status = 'DONE'")
[ "$done_count" = 50 ] || fail "only $done_count / 50 race tasks ended DONE"
total=$(stats | node -e 'const s=JSON.parse(require("fs").readFileSync(0)); console.log(Object.values(s).reduce((a,b)=>a+b,0))')
echo "race: 50/50 DONE, LLM calls $total for 200 needed, wasted $((total - 200)) (naive claim; phase 5 target: 0)"
echo "PASS: phase 1 baseline"
