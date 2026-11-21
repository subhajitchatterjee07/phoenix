#!/usr/bin/env bash
# Phase 0 chaos test: the whole stack starts, migrations run first, the schema exists.
# Non-destructive: keeps your database volume. For a truly fresh start run `npm run db:reset` first.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "FAIL: $*"; exit 1; }

out=$(docker compose up -d --build --wait api worker dispatcher fake-llm fake-email 2>&1) || fail "compose up failed:\n$out"

[ "$(docker compose ps -a migrate --format '{{.ExitCode}}')" = "0" ] || fail "migrate did not exit 0"
[ "$(docker compose ps worker --status running -q | wc -l)" -eq 3 ] || fail "expected 3 running workers"
for svc in api dispatcher fake-llm fake-email; do
  [ -n "$(docker compose ps "$svc" --status running -q)" ] || fail "$svc is not running"
done

tables=$(docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT string_agg(tablename, \$\$,\$\$ ORDER BY tablename) FROM pg_tables WHERE schemaname = \$\$public\$\$"')
[ "$tables" = "decisions,events,outbox,schema_migrations,tasks" ] || fail "unexpected tables: $tables"

[ "$(curl -s -o /dev/null -w '%{http_code}' localhost:8000/)" = "404" ] || fail "api not answering on 8000"
curl -sf localhost:9001/stats >/dev/null || fail "fake-llm not answering on 9001"

echo "PASS: phase 0 (migrate exit 0, 3 workers, api, dispatcher, fake-llm, fake-email up, 5 tables)"
