#!/usr/bin/env bash
set -euo pipefail

# Initial PostgreSQL/PostGIS installation ONLY. Read-only assertion.
# An existing business schema always requires the verified backup gate.
fail() { printf 'BLOCKED initial bootstrap: %s\n' "$1" >&2; exit 2; }

[[ $# -eq 0 ]] || fail "arguments are not accepted"
release="${SEDEAGRO_RELEASE_SHA:-}"
[[ "$release" =~ ^[0-9a-f]{40}$ ]] || fail "exact full release SHA required"
[[ "${SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL:-}" == "FIRST_DEPLOY:$release" ]] ||
  fail "explicit FIRST_DEPLOY:<SHA40> confirmation is required"
for key in SEDEAGRO_VERIFIED_BACKUP_FILE SEDEAGRO_VERIFIED_BACKUP_SHA256 SEDEAGRO_RESTORE_APPROVAL; do
  [[ -z "${!key:-}" ]] || fail "cannot combine first install and backup/restore approval variables"
done
owner="${POSTGRES_USER:-}"
database="${POSTGRES_DB:-}"
[[ "$owner" =~ ^[a-z_][a-z0-9_]*$ && "$database" =~ ^[a-z_][a-z0-9_]*$ ]] ||
  fail "valid database and owner identifiers required"
command -v docker >/dev/null 2>&1 || fail "Docker Compose is required"

# The very same read-only SQL is executed against the disposable PostGIS
# service by CI BEFORE and AFTER real SedeAgro migrations.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="$ROOT/scripts/sql/first-install-footprint.sql"
[[ -f "$SQL_FILE" && ! -L "$SQL_FILE" ]] || fail "inspection SQL is missing or a symlink"

if ! footprint="$(docker compose exec -T db psql -X -A -t -q \
  -v ON_ERROR_STOP=1 -U "$owner" -d "$database" < "$SQL_FILE" 2>/dev/null)"; then
  fail "PostgreSQL inspection failed; cannot prove database is untouched"
fi
# Reject warnings, unexpected rows or non-empty schema. Psql normally emits
# exactly a single compact row with its trailing newline removed by $().
[[ "$footprint" == "0|0" ]] ||
  fail "database contains pre-existing non-extension relations or custom schemas"
printf 'PASS read-only fresh database gate: no non-extension objects for exact release %s.\n' "$release"
printf 'CAUTION: approved first installation only; later upgrades MUST pass verified backup and restore gate.\n'