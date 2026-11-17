#!/usr/bin/env bash
# kill -9 one random running worker container (LLD §10) and print its id.
set -euo pipefail
cd "$(dirname "$0")/../.."
victim=$(docker compose ps worker --status running -q | shuf -n 1)
[ -n "$victim" ] || { echo "no running worker to kill" >&2; exit 1; }
docker kill --signal KILL "$victim" >/dev/null
echo "$victim"
