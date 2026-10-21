#!/usr/bin/env bash
set -euo pipefail

# Only GitHub's disposable PostGIS CI service. Never accepts database URLs,
# arbitrary names, hosts, paths to backups or a production Docker Compose.
SOURCE_DB='sedeagro_test'
RESTORED_DB='sedeagro_restore_test'
OWNER='sedeagro_owner'
APP_ROLE='sedeagro_app'

if [[ "${CI:-}" != "true" || "${GITHUB_ACTIONS:-}" != "true" ||
      "${SEDEAGRO_DISPOSABLE_RESTORE:-}" != "I_ACCEPT_ONLY_CI_TEST_DATABASES" ]]; then
  echo 'BLOCKED: disposable CI confirmation is required.' >&2
  exit 2
fi
if [[ $# -eq 1 && "$1" == "--check-only" ]]; then
  echo 'PASS: CI-only guard enabled; no database or Docker operation performed.'
  exit 0
fi
if [[ $# -ne 1 || "$1" != "--run" ]]; then
  echo 'Usage: ci-disposable-restore.sh --check-only|--run' >&2
  exit 2
fi

: "${CI_POSTGIS_CONTAINER:?A GitHub Actions PostGIS service container ID is required}"
: "${RESTORE_TEST_APP_PASSWORD:?A disposable test-only password is required}"
if [[ "$CI_POSTGIS_CONTAINER" != [a-f0-9]* ||
      ! "$CI_POSTGIS_CONTAINER" =~ ^[a-f0-9]{12,64}$ ||
      ! "$RESTORE_TEST_APP_PASSWORD" =~ ^[A-Za-z0-9._~-]{12,128}$ ]]; then
  echo 'BLOCKED: invalid CI service container or ephemeral test credential.' >&2
  exit 2
fi
for cmd in docker npm mktemp sha256sum grep; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }
done
image="$(docker inspect --format '{{.Config.Image}}' "$CI_POSTGIS_CONTAINER")"
if [[ "$image" != 'postgis/postgis:16-3.4' ]]; then
  echo 'BLOCKED: this is not the pinned disposable PostGIS service image.' >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test -f "$root/scripts/provision-runtime-role.sql" || exit 2
test -f "$root/backend/package.json" || exit 2
test -f "$root/scripts/sql/restore-data-fingerprint.sql" || exit 2

sql() {
  local database="$1" query="$2"
  docker exec "$CI_POSTGIS_CONTAINER" psql -X -A -t -q \
    -v ON_ERROR_STOP=1 -U "$OWNER" -d "$database" -c "$query" |
    tr -d '\r\n'
}
if [[ "$(sql postgres "SELECT count(*) FROM pg_database WHERE datname = '$SOURCE_DB'")" != "1" ||
      "$(sql postgres "SELECT count(*) FROM pg_database WHERE datname = '$RESTORED_DB'")" != "0" ]]; then
  echo 'BLOCKED: source test database missing or disposable restore target already exists.' >&2
  exit 2
fi

# Compare schema/migrations/catalog RLS before and after a real archive restore.
fingerprint() {
  local database="$1"
  sql "$database" "SELECT
    md5(coalesce((SELECT string_agg(name, ',' ORDER BY name)
      FROM sequelize_migrations),'')) || ':' ||
    (SELECT count(*) FROM sequelize_migrations)::text || ':' ||
    (SELECT count(*) FROM plans)::text || ':' ||
    (SELECT count(*) FROM crop_types)::text || ':' ||
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity)::text || ':' ||
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND c.relrowsecurity AND c.relforcerowsecurity)::text"
}
# A schema footprint alone can miss lost or mutated rows with matching
# counts. Hash actual row content (including duplicates) and sequence state.
# This runner is deliberately locked to the two GitHub disposable DB names.
data_fingerprint() {
  local database="$1"
  docker exec -i "$CI_POSTGIS_CONTAINER" psql -X -A -t -q \
    -v ON_ERROR_STOP=1 -U "$OWNER" -d "$database" -f - \
    < "$root/scripts/sql/restore-data-fingerprint.sql" | tr -d '\r\n'
}
before="$(fingerprint "$SOURCE_DB")"
data_before="$(data_fingerprint "$SOURCE_DB")"
[[ "$data_before" =~ ^([0-9]+)\|([0-9]+)\|[0-9a-f]{32}$ ]] || {
  echo 'BLOCKED: disposable source data fingerprint is malformed.' >&2
  exit 1
}
(( ${BASH_REMATCH[1]} >= 20 )) || {
  echo 'BLOCKED: disposable source has too few application tables.' >&2
  exit 1
}
IFS=: read -r _ migrations plans crops rls forced <<< "$before"
if [[ "$migrations" -lt 10 || "$plans" -lt 1 || "$crops" -lt 1 ||
      "$rls" -lt 20 || "$rls" != "$forced" ]]; then
  echo 'BLOCKED: migrated PostGIS source does not meet RLS/seed prerequisites.' >&2
  exit 1
fi

umask 077
private_dir="$(mktemp -d)"
dump="$private_dir/ci-postgis.dump"
list="$private_dir/archive.list"
created=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$created" == 1 ]]; then
    docker exec "$CI_POSTGIS_CONTAINER" dropdb --if-exists \
      -U "$OWNER" --force "$RESTORED_DB" >/dev/null 2>&1 || {
        echo 'WARNING: disposable restore DB could not be deleted.' >&2
        status=1
      }
  fi
  rm -f -- "$dump" "$list"
  rmdir -- "$private_dir" 2>/dev/null || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo 'Creating a private, ephemeral pg_dump archive from CI source...'
docker exec "$CI_POSTGIS_CONTAINER" pg_dump -U "$OWNER" -d "$SOURCE_DB" \
  --format=custom --no-owner --no-acl > "$dump"
test -s "$dump"
docker exec -i "$CI_POSTGIS_CONTAINER" pg_restore --list < "$dump" > "$list"
for required in 'auth_sessions' 'evidence_blobs' 'sequelize_migrations' 'tenant_modules'; do
  grep -qF "$required" "$list" || {
    echo "BLOCKED: missing $required in pg_restore archive." >&2
    exit 1
  }
done
archive_sha="$(sha256sum "$dump" | cut -d' ' -f1)"
echo "PASS: pg_restore --list accepted encrypted-storage-safe CI archive SHA256 ${archive_sha:0:12}…"
docker exec "$CI_POSTGIS_CONTAINER" createdb -U "$OWNER" -O "$OWNER" \
  --template=template0 "$RESTORED_DB"
created=1
docker exec -i "$CI_POSTGIS_CONTAINER" pg_restore \
  -U "$OWNER" -d "$RESTORED_DB" --exit-on-error \
  --no-owner --no-acl < "$dump"

after="$(fingerprint "$RESTORED_DB")"
data_after="$(data_fingerprint "$RESTORED_DB")"
if [[ "$after" != "$before" ]]; then
  echo 'BLOCKED: restored migrations/catalog/RLS footprint differs from source.' >&2
  exit 1
fi
if [[ "$data_after" != "$data_before" ]]; then
  echo 'BLOCKED: restored application rows/sequence state differ from source.' >&2
  exit 1
fi
echo 'PASS: restored migration versions, catalogs, FORCE RLS, application row contents and sequence state match original.'

# 0P.21: BEFORE restored-db RLS/HTTP suite, rehearse a post-backup write
# window against the disposable SOURCE and verify every fixture is reverted.
# No backup restore or arbitrary DB targets are offered by this helper.
bash "$root/scripts/ci-rollback-rehearsal.sh" --run

# Privileges are intentionally stripped from the archive: provision a fresh
# runtime role grant on the restored database before the API integration suite.
docker exec -i "$CI_POSTGIS_CONTAINER" psql -X -q -U "$OWNER" \
  -d "$RESTORED_DB" -v ON_ERROR_STOP=1 -v "db_owner=$OWNER" \
  -v "app_user=$APP_ROLE" -v "app_password=$RESTORE_TEST_APP_PASSWORD" \
  < "$root/scripts/provision-runtime-role.sql"

# Existing integration suite creates two tenants and proves isolation,
# authorizations, cookies, RLS and FK behavior on the *restored* database.
export TEST_DATABASE_ADMIN_URL="postgres://$OWNER:temporary-ci-owner-password@127.0.0.1:5432/$RESTORED_DB"
export TEST_DATABASE_APP_URL="postgres://$APP_ROLE:$RESTORE_TEST_APP_PASSWORD@127.0.0.1:5432/$RESTORED_DB"
echo 'Running the PostGIS application/RLS suite on RESTORED disposable database...'
(cd "$root" && npm --workspace backend run test:db)
echo 'PASS: backup → pg_restore → catalog/FORCE RLS → runtime-role → restored-db API suite.'
