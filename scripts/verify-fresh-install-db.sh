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

# Count all non-extension-owned user relations and all non-extension-owned
# schemas other than public. Exclude pg_catalog, pg_toast and internal schemas.
# Extension-owned PostGIS relations (e.g. spatial_ref_sys) are allowed.
# This deliberately rejects partial migrations or ANY unrelated custom data.
sql="SELECT
  (SELECT count(*) FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname <> 'information_schema'
     AND left(n.nspname, 3) <> 'pg_'
     AND c.relkind IN ('r','p','f','m','v')
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend dep
       WHERE dep.classid = 'pg_class'::regclass
         AND dep.refclassid = 'pg_extension'::regclass
         AND dep.objid = c.oid AND dep.deptype = 'e'
     ))
  || '|' ||
  (SELECT count(*) FROM pg_namespace n
   WHERE n.nspname <> 'public'
     AND n.nspname <> 'information_schema'
     AND left(n.nspname, 3) <> 'pg_'
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend dep
       WHERE dep.classid = 'pg_namespace'::regclass
         AND dep.refclassid = 'pg_extension'::regclass
         AND dep.objid = n.oid AND dep.deptype = 'e'
     ));"

if ! footprint="$(docker compose exec -T db psql -X -A -t -q \
  -v ON_ERROR_STOP=1 -U "$owner" -d "$database" -c "$sql" 2>/dev/null)"; then
  fail "PostgreSQL inspection failed; cannot prove database is untouched"
fi
# Reject warnings, unexpected rows or non-empty schema. Psql normally emits
# exactly a single compact row with its trailing newline removed by $().
[[ "$footprint" == "0|0" ]] ||
  fail "database contains pre-existing non-extension relations or custom schemas"
printf 'PASS read-only fresh database gate: no non-extension objects for exact release %s.\n' "$release"
printf 'CAUTION: approved first installation only; later upgrades MUST pass verified backup and restore gate.\n'