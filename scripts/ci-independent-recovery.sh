#!/usr/bin/env bash
set -Eeuo pipefail

# 0P.23: CI-only independent PostgreSQL/PostGIS recovery. The source pg_dump
# was already created by ci-disposable-restore.sh from disposable synthetic DB.
# NEVER accepts DB URLs, hostnames, production archives or mutable DB names.
fail() { printf 'BLOCKED CI independent recovery: %s\n' "$1" >&2; exit 2; }

if [[ "${CI:-}" != true || "${GITHUB_ACTIONS:-}" != true ||
      "${SEDEAGRO_DISPOSABLE_RESTORE:-}" != I_ACCEPT_ONLY_CI_TEST_DATABASES ||
      "${SEDEAGRO_INDEPENDENT_RECOVERY:-}" != I_ACCEPT_NETWORKLESS_CI_RECOVERY ]]; then
  fail 'four independent CI-only confirmations required'
fi
if [[ "$#" == 1 && "$1" == --check-only ]]; then
  echo 'PASS CI-only independent recovery guard: no Docker, files or database touched.'
  exit 0
fi
[[ "$#" == 1 && "$1" == --run ]] || fail 'expected exactly --check-only or --run'

for command in docker sha256sum realpath stat tr grep sleep; do
  command -v "$command" >/dev/null 2>&1 || fail 'missing CI tool'
done

SOURCE_ID="${CI_POSTGIS_CONTAINER:-}"
ARCHIVE="${CI_RECOVERY_ARCHIVE:-}"
EXPECTED_SHA="${CI_RECOVERY_ARCHIVE_SHA256:-}"
EXPECTED_DATA="${CI_RECOVERY_EXPECTED_DATA:-}"
EXPECTED_CATALOG="${CI_RECOVERY_EXPECTED_CATALOG:-}"
OWNER='sedeagro_owner'
TARGET='sedeagro_restore_test'
BOOTSTRAP='sedeagro_recovery_bootstrap'
APP='sedeagro_app'
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "$SOURCE_ID" =~ ^[a-f0-9]{12,64}$ &&
   "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ &&
   "$EXPECTED_DATA" =~ ^[0-9]{2,4}\|[0-9]{1,4}\|[a-f0-9]{32}$ &&
   "$EXPECTED_CATALOG" =~ ^[a-f0-9]{32}(:[0-9]{1,8}){5}$ ]] ||
  fail 'missing or malformed immutable synthetic test evidence'
[[ "$ARCHIVE" == /tmp/* && "$ARCHIVE" =~ ^/[A-Za-z0-9._/-]+$ &&
   -f "$ARCHIVE" && ! -L "$ARCHIVE" &&
   "$(realpath -e "$ARCHIVE" 2>/dev/null || true)" == "$ARCHIVE" ]] ||
  fail 'archive must be an existing canonical private /tmp CI-only file'
parent="${ARCHIVE%/*}"
[[ -d "$parent" && ! -L "$parent" && -O "$ARCHIVE" && -O "$parent" ]] ||
  fail 'archive and its parent must belong to the CI runner'
for item in "$parent" "$ARCHIVE"; do
  mode="$(stat -c %a "$item")" || fail 'archive permissions unavailable'
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail 'malformed archive permissions'
  (( (8#$mode & 077) == 0 )) || fail 'archive or parent is accessible to other users'
done
[[ "$(stat -c %s "$ARCHIVE")" -gt 4096 ]] ||
  fail 'custom archive is unexpectedly small'
[[ "$(sha256sum "$ARCHIVE" | cut -d ' ' -f1)" == "$EXPECTED_SHA" ]] ||
  fail 'archive digest differs from source manifest'
[[ -f "$root/scripts/sql/restore-data-fingerprint.sql" &&
   -f "$root/scripts/sql/ci-independent-recovery-rls.sql" &&
   -f "$root/scripts/provision-runtime-role.sql" ]] ||
  fail 'missing CI-only immutable SQL inputs'

[[ "$(docker inspect --format '{{.Config.Image}}' "$SOURCE_ID" 2>/dev/null)" == \
  'postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5' ]] || fail 'source must be pinned disposable PostGIS container'

isolated=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$isolated" ]]; then
    if ! docker stop --time 5 "$isolated" >/dev/null 2>&1; then
      if docker inspect "$isolated" >/dev/null 2>&1; then
        echo 'BLOCKED: independent recovery container could not be removed' >&2
        status=1
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# New container, new anonymous PGDATA volume, no network namespace access
# and no ports. The pinned image must already exist in CI: no registry pulls.
isolated="$(docker run --detach --rm --pull never --network none \
  --pids-limit 256 --memory 1g \
  --label 'sedeagro.ci.independent-recovery=synthetic-only' \
  --env POSTGRES_DB="$BOOTSTRAP" \
  --env POSTGRES_USER="$OWNER" \
  --env POSTGRES_PASSWORD=temporary-ci-independent-recovery-password \
  postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5)" || fail 'cannot create networkless PostGIS container'
[[ "$isolated" =~ ^[a-f0-9]{64}$ ]] || fail 'Docker returned invalid recovery container identity'
[[ "$isolated" != "$SOURCE_ID" ]] || fail 'recovery must not reuse source container'
[[ "$(docker inspect --format '{{.Config.Image}}' "$isolated")" == \
  'postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5' &&
   "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$isolated")" == none &&
   "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$isolated")" == 0 ]] ||
  fail 'independent PostGIS lacks network/port isolation'
# The PostGIS image declares a fresh, anonymous /var/lib/postgresql/data volume.
# No existing source/prod mounts or bind paths are allowed.
mounts="$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$isolated")"
[[ "$mounts" == 'volume:/var/lib/postgresql/data ' ]] ||
  fail 'independent PostGIS has unexpected persistent or bind mounts'

ready=0
for _ in $(seq 1 60); do
  # The official PostGIS entrypoint first launches a TEMPORARY postmaster
  # during initdb, then sends it an administrator shutdown. pg_isready may
  # succeed during that temporary phase. Require PID 1 to be the FINAL
  # exec'd postgres server before connecting, or pg_restore can get FATAL:
  # "terminating connection due to administrator command" mid-stream.
  pid1="$(docker exec "$isolated" cat /proc/1/comm 2>/dev/null || true)"
  if [[ "$pid1" == postgres ]] &&
     docker exec "$isolated" pg_isready -U "$OWNER" -d "$BOOTSTRAP" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || fail 'final independent PostGIS server never achieved stable readiness'

# The PostGIS image automatically seeds extensions in POSTGRES_DB. Never
# restore the archive into that pre-seeded database: pg_restore would collide
# with extensions already present. Create an empty, fixed restore target from
# template0 INSIDE THE NEW DISPOSABLE CONTAINER only.
existing="$(docker exec "$isolated" psql -X -A -t -q -v ON_ERROR_STOP=1 \
  -U "$OWNER" -d "$BOOTSTRAP" -c \
  "SELECT count(*) FROM pg_database WHERE datname = '$TARGET'" | tr -d '\r\n')" ||
  fail 'cannot verify independent restore target freshness'
[[ "$existing" == 0 ]] || fail 'independent restore target already exists'
docker exec "$isolated" createdb -U "$OWNER" -O "$OWNER" \
  --template=template0 "$TARGET" || fail 'cannot create clean disposable restore target'

# Prove custom-archive TOC readability on another PostGIS instance.
toc="$(docker exec -i "$isolated" pg_restore --list < "$ARCHIVE")" ||
  fail 'independent PostGIS rejected backup TOC'
for required in sequelize_migrations tenants auth_sessions fields work_orders evidence_blobs; do
  grep -qF "$required" <<< "$toc" || fail 'archive is missing a core application object'
done
unset toc

# Use only the container-local PostgreSQL socket via docker exec. Do not expose
# a network port, connect to the CI source or write to any operator DB.
docker exec -i "$isolated" pg_restore --exit-on-error --no-owner --no-acl \
  -U "$OWNER" -d "$TARGET" < "$ARCHIVE" ||
  fail 'independent pg_restore failed'

data_fingerprint="$(docker exec -i "$isolated" psql -X -A -t -q \
  -v ON_ERROR_STOP=1 -U "$OWNER" -d "$TARGET" -f - \
  < "$root/scripts/sql/restore-data-fingerprint.sql" | tr -d '\r\n')" ||
  fail 'independent restored data cannot be fingerprinted'
[[ "$data_fingerprint" == "$EXPECTED_DATA" ]] ||
  fail 'independent restored rows, sequences or relation inventory diverge'

catalog="$(docker exec "$isolated" psql -X -A -t -q -v ON_ERROR_STOP=1 \
  -U "$OWNER" -d "$TARGET" -c "
SELECT
  md5(coalesce((SELECT string_agg(name, ',' ORDER BY name)
    FROM sequelize_migrations),'')) || ':' ||
  (SELECT count(*) FROM sequelize_migrations)::text || ':' ||
  (SELECT count(*) FROM plans)::text || ':' ||
  (SELECT count(*) FROM crop_types)::text || ':' ||
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity)::text || ':' ||
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relrowsecurity AND c.relforcerowsecurity)::text" | tr -d '\r\n')" ||
  fail 'independent schema and RLS footprint query failed'
[[ "$catalog" == "$EXPECTED_CATALOG" ]] ||
  fail 'independent restored migrations/catalogs/FORCE RLS differ'

# Privileges are intentionally stripped by pg_dump: provision an independent
# non-owner runtime role on THIS ephemeral DB, then prove actual tenant isolation.
docker exec -i "$isolated" psql -X -q -v ON_ERROR_STOP=1 \
  -U "$OWNER" -d "$TARGET" \
  -v db_owner="$OWNER" -v app_user="$APP" \
  -v app_password=temporary-ci-independent-app-password \
  < "$root/scripts/provision-runtime-role.sql" >/dev/null ||
  fail 'independent recovered role could not be safely provisioned'
docker exec -i "$isolated" psql -X -q -v ON_ERROR_STOP=1 \
  -U "$OWNER" -d "$TARGET" \
  -f - < "$root/scripts/sql/ci-independent-recovery-rls.sql" >/dev/null ||
  fail 'independent recovered tenant FORCE RLS checks failed'

# Detect archive mutation during the test (including same-size replacements).
[[ "$(sha256sum "$ARCHIVE" | cut -d ' ' -f1)" == "$EXPECTED_SHA" ]] ||
  fail 'archive changed during independent recovery'
echo 'PASS CI-independent recovery: separate networkless PostGIS, full rows/sequences/catalogs, non-owner runtime and real two-tenant FORCE RLS.'
echo 'NOT CERTIFIED: real backup custody, separate physical host, registry digest, staging or pilot.'
