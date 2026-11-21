#!/usr/bin/env bash
# Freeze one worker for N seconds, then thaw it (LLD §10), like a long GC pause or a stalled VM.
# Usage: freeze.sh SECONDS [CONTAINER_ID]; default: a random running worker. Prints the id.
# `docker pause`, not `docker kill --signal STOP`: with `init: true`, PID 1 is docker-init,
# and SIGSTOP stops only docker-init while node keeps running (seen: init `T`, node `Sl`).
# pause uses the cgroup freezer, so every process in the container stops.
set -euo pipefail
cd "$(dirname "$0")/../.."
secs=${1:?usage: freeze.sh SECONDS [CONTAINER_ID]}
victim=${2:-$(docker compose ps worker --status running -q | shuf -n 1)}
[ -n "$victim" ] || { echo "no running worker to freeze" >&2; exit 1; }
docker pause "$victim" >/dev/null
trap 'docker unpause "$victim" >/dev/null 2>&1 || true' EXIT # never leave it frozen
sleep "$secs"
echo "$victim"
