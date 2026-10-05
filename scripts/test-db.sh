#!/usr/bin/env bash
# Applies the migrations to a throwaway database and runs the SQL tests.
# Requires a reachable PostgreSQL 15+ server and a superuser connection via standard
# libpq env vars (PGHOST, PGPORT, PGUSER, PGPASSWORD). Never point this at a real project.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="trademonk_test_$$"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database ${DB}"
trap 'psql -q -d postgres -c "drop database if exists ${DB}" >/dev/null' EXIT

run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1"; }

run supabase/tests/00_stub_supabase.sql
for f in supabase/migrations/*.sql; do echo "migrate: $f"; run "$f"; done

OUT=$(mktemp)
if psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/rls_and_immutability.test.sql 2>"$OUT"; then
  echo "PASS lines: $(grep -c 'PASS:' "$OUT")"
else
  grep -E "FAIL|ERROR" "$OUT" || cat "$OUT"
  exit 1
fi

# Real multi-session tests (row-lock serialisation, deadlocks, rollback across a commit boundary).
bash supabase/tests/concurrency.sh "$DB"
echo "DB tests passed."
