#!/usr/bin/env bash
set -euo pipefail

# Read-only verification of an OPERATOR-PROVIDED, previously RESTORED archive.
# Run only with the project PostGIS container started, before migrations.
# This script never creates/overwrites/restores a database or prints its data.
fail() { printf 'BLOCKED backup gate: %s\n' "$1" >&2; exit 2; }

[[ $# -eq 0 ]] || fail "arguments are not accepted"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# This gate may also be used standalone. Never let a caller silently select
# another daemon, Compose file, project, env file or profile.
for override in \
  DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG \
  DOCKER_DEFAULT_PLATFORM BUILDX_BUILDER \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES COMPOSE_PROFILES \
  COMPOSE_DISABLE_ENV_FILE COMPOSE_PATH_SEPARATOR COMPOSE_IGNORE_ORPHANS
do
  [[ -z "${!override:-}" ]] || fail "Docker/Compose override forbidden: $override"
done
[[ -f "$ROOT/docker-compose.yml" && ! -L "$ROOT/docker-compose.yml" ]] ||
  fail "reviewed production Compose file is missing or linked"
compose=(docker compose --project-directory "$ROOT" \
  --file "$ROOT/docker-compose.yml" --project-name sedeagro)
release="${SEDEAGRO_RELEASE_SHA:-}"
backup="${SEDEAGRO_VERIFIED_BACKUP_FILE:-}"
expected="${SEDEAGRO_VERIFIED_BACKUP_SHA256:-}"

[[ "$release" =~ ^[0-9a-f]{40}$ ]] || fail "missing full approved release SHA"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "missing full SHA256 of verified backup"
[[ "${SEDEAGRO_RESTORE_APPROVAL:-}" == "RESTORED:$release:$expected" ]] ||
  fail "operator must explicitly attest RESTORED:<release SHA>:<backup SHA256> after external restore"

for cmd in docker sha256sum stat realpath awk date; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required tool $cmd"
done
[[ "$backup" == /* && "$backup" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
  fail "backup path must be absolute with safe characters"
[[ -f "$backup" && ! -L "$backup" ]] ||
  fail "backup must exist as a regular, non-symlink archive"
[[ "$(realpath -e "$backup" 2>/dev/null || true)" == "$backup" ]] ||
  fail "backup path must be canonical, without symlinked parents or .. segments"
[[ "$backup" != "$ROOT/"* && "$backup" != /tmp/* &&
   "$backup" != /var/tmp/* && "$backup" != /dev/shm/* ]] ||
  fail "backup cannot be under repository or ephemeral system directories"

dir="${backup%/*}"
[[ -d "$dir" && ! -L "$dir" ]] || fail "backup parent directory is invalid"
for target in "$dir" "$backup"; do
  mode="$(stat -c '%a' "$target" 2>/dev/null)" || fail "unable to stat backup permissions"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "invalid backup permissions"
  (( (8#$mode & 077) == 0 )) || fail "backup and its directory require private permissions (0700/0600)"
done
[[ -O "$backup" && -O "$dir" ]] || fail "backup and directory must belong to deploy operator"
bytes="$(stat -c '%s' "$backup")"
modified="$(stat -c '%Y' "$backup")"
now="$(date +%s)"
[[ "$bytes" =~ ^[0-9]+$ && "$modified" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] ||
  fail "invalid backup metadata"
(( bytes > 4096 )) || fail "backup archive is unexpectedly small"
(( modified <= now && now - modified <= 86400 )) ||
  fail "backup must be created within the last 24 hours"

actual="$(sha256sum "$backup" | cut -d ' ' -f 1)"
[[ "$actual" == "$expected" ]] || fail "backup archive SHA256 mismatch"

# Bind the read-only TOC inspection to the *actual* production PostGIS
# container. A same-name service in another project, replaced DB, wrong
# Docker image or unhealthy container must not be mistaken for production.
# Never print docker inspect results: environment may contain secrets.
source_container=''
verify_db_identity() {
  local id info
  id="$("${compose[@]}" ps --quiet db 2>/dev/null)" ||
    fail "production Compose DB service cannot be listed"
  [[ "$id" =~ ^[0-9a-f]{64}$ ]] ||
    fail "expected one full production DB container ID"
  [[ -z "$source_container" || "$id" == "$source_container" ]] ||
    fail "production DB container was replaced during backup check"
  info="$(docker inspect --type=container --format \
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}|{{.State.Running}}|{{.State.Health.Status}}' \
    "$id" 2>/dev/null)" ||
    fail "production DB container identity not readable"
  [[ "$info" == "$id|/sedeagro_db|sedeagro|db|postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5|true|healthy" ]] ||
    fail "production DB project, image or health does not match"
  source_container="$id"
}

# Compose DB must already be running. Verify custom archive is readable with
# the pinned PostGIS pg_restore; never accept arbitrary SQL or apply a restore.
verify_db_identity
if ! archive_list="$("${compose[@]}" exec -T db pg_restore --list < "$backup")"; then
  fail "pg_restore cannot read archive TOC in the pinned PostGIS container"
fi
verify_db_identity
[[ "$(sha256sum "$backup" | cut -d ' ' -f 1)" == "$expected" ]] ||
  fail "backup changed while pg_restore read its table of contents"
# pg_restore -l emits: ID; OID OID TABLE schema name owner.
# A substring match can be forged by TOC comments, TABLE DATA entries,
# prefixes (work_orders_old) or objects in another schema. Count ONLY exact,
# single public TABLE definitions for the six release-critical entities.
# This proves archive structure, NOT that the operator actually restored it.
if ! awk '
  BEGIN {
    split("sequelize_migrations tenants auth_sessions fields work_orders evidence_blobs", names, " ")
    for (i in names) expected[names[i]] = 0
  }
  $1 ~ /^[0-9]+;$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ &&
    $4 == "TABLE" && $5 == "public" && ($6 in expected) {
      expected[$6]++
  }
  END {
    for (name in expected) if (expected[name] != 1) bad = 1
    if (bad) exit 1
  }
' <<< "$archive_list"; then
  fail "backup TOC missing or duplicating exact required public table definitions"
fi

printf 'PASS read-only backup gate: recent private archive, matching SHA256 and pg_restore TOC for release %s.\n' "$release"
printf 'CAUTION: external restore verification is an operator attestation, not proved by this check.\n'