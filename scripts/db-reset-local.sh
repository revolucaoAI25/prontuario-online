#!/usr/bin/env bash
# Recreates a local Postgres database with the Supabase shim, all migrations
# and the seed. For development and tests only.
#
# Usage: scripts/db-reset-local.sh [database_name]
set -euo pipefail

DB="${1:-prontuario}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 -q -X)
export PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"

"${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\" with (force)"
"${PSQL[@]}" -d postgres -c "create database \"$DB\""
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/local_supabase_shim.sql"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "$DB" -f "$migration"
done
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/seed.sql"
echo "Database $DB ready."
