#!/usr/bin/env bash
# Chaos 4, the phase 4 gate (PHX-034): crash at each named failpoint with the full stack up,
# and check that every email is delivered exactly once.
#   1. worker, CRASH_AT=between_event_and_outbox: dies mid-transaction -> the step left NO rows
#   2. worker, CRASH_AT=after_outbox_commit: dies after commit -> the event + ONE outbox row
#   3. three normal workers finish every task (their naive claim race is covered too:
#      a duplicate send_email save is Fenced, and its outbox row rolls back with it)
#   4. dispatcher, CRASH_AT=after_send_before_sent: delivered, row still PENDING -> a normal
#      dispatcher resends with the SAME key and the provider dedupes it
# Pass: all tasks DONE; one outbox row per task, all SENT; the fake's keys are exactly the
# outbox keys, each delivered once; at least one key was requested twice (crash 4 resent it).
# FAST-FORWARDED LEASE EXPIRY as in kill-loop.sh: after a worker crash, its lease is expired at once.
set -euo pipefail
cd "$(dirname "$0")/../.."
TASKS=${1:-5}
fail() { echo "FAIL: $*"; exit 1; }
sql() { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1' <<<"$1"; }
until_true() { # $1 = shell condition, $2 = timeout seconds, $3 = what we wait for
  for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done
  fail "timed out after $2 s waiting for: $3"
}
exited_137() { [ "$(docker compose ps -a "$1" --format '{{.ExitCode}}' | head -1)" = 137 ]; }
crash() { # $1 = service, $2 = failpoint: start ONE with CRASH_AT, wait for the SIGKILL
  CRASH_AT=$2 docker compose up -d --no-deps --scale "$1"=1 "$1" >/dev/null 2>&1
  until_true "exited_137 $1" 60 "$1 to die at $2"
  docker compose logs "$1" 2>&1 | grep -q "failpoint $2: SIGKILL" || fail "$1 died, but not at $2"
}

out=$(docker compose up -d --build --wait 2>&1) || fail "compose up failed:\n$out"
docker compose stop worker dispatcher >/dev/null 2>&1
curl -sf -X POST localhost:9002/reset >/dev/null
first=$(sql "INSERT INTO tasks (goal, input) SELECT 'chaos outbox ' || g,
  '{\"sources\":[\"a\",\"b\"],\"email\":{\"to\":\"boss@example.com\",\"guarantee\":\"AT_LEAST_ONCE\"}}'
  FROM generate_series(1, $TASKS) g RETURNING task_id" | head -1)
mine="task_id >= $first"

crash worker between_event_and_outbox
t=$(sql "SELECT task_id FROM tasks WHERE $mine AND status = 'RUNNING'")
[ "$(sql "SELECT count(*) FROM outbox WHERE task_id = $t")" = 0 ] || fail "crash 1: task $t has an outbox row"
[ "$(sql "SELECT count(*) FROM events WHERE task_id = $t AND step_type = 'send_email'")" = 0 ] || fail "crash 1: send_email event survived"
sql "UPDATE tasks SET lease_expires_at = now() WHERE $mine AND status = 'RUNNING'" >/dev/null
echo "crash 1 (between_event_and_outbox), task $t: no event, no outbox row"

crash worker after_outbox_commit
# Crash 1's task is RUNNING too (its lease expired above): crash 2's is the one with a live lease.
t=$(sql "SELECT task_id FROM tasks WHERE $mine AND status = 'RUNNING' AND lease_expires_at > now()")
[ "$(sql "SELECT count(*) FROM outbox WHERE task_id = $t")" = 1 ] || fail "crash 2: task $t should have exactly 1 outbox row"
sql "UPDATE tasks SET lease_expires_at = now() WHERE $mine AND status = 'RUNNING'" >/dev/null
echo "crash 2 (after_outbox_commit), task $t: event + 1 outbox row"

docker compose up -d --no-deps --scale worker=3 worker >/dev/null 2>&1
until_true "[ \"\$(sql \"SELECT count(*) FROM tasks WHERE $mine AND status <> 'DONE'\")\" = 0 ]" 120 "all tasks DONE"
[ "$(sql "SELECT count(*) FROM outbox WHERE $mine")" = "$TASKS" ] || fail "expected $TASKS outbox rows (one per task)"

crash dispatcher after_send_before_sent
docker compose up -d --no-deps dispatcher >/dev/null 2>&1
until_true "[ \"\$(sql \"SELECT count(*) FROM outbox WHERE $mine AND status <> 'SENT'\")\" = 0 ]" 120 "all outbox rows SENT"
echo "crash 3 (after_send_before_sent): dispatcher restarted, all $TASKS rows SENT"

keys=$(sql "SELECT idem_key FROM outbox WHERE $mine ORDER BY idem_key")
curl -sf localhost:9002/stats | node -e '
  const stats = JSON.parse(require("fs").readFileSync(0)), keys = process.argv[1].split("\n");
  const seen = Object.keys(stats).sort();
  if (seen.join() !== keys.join()) { console.log(`provider keys ${seen.length} != outbox keys ${keys.length}`); process.exit(1); }
  const bad = keys.filter((k) => stats[k].deliveries !== 1);
  if (bad.length) { console.log(`${bad.length} keys not delivered exactly once`); process.exit(1); }
  const resent = keys.filter((k) => stats[k].requests > 1).length;
  if (resent === 0) { console.log("no key was requested twice: crash 3 resent nothing"); process.exit(1); }
  console.log(`${keys.length} emails, each delivered once; ${resent} resent after the crash and deduped`);' "$keys" \
  || fail "delivery check"
echo "PASS: phase 4 outbox"
