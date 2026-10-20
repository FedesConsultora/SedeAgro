#!/usr/bin/env bash
set -euo pipefail

# Read-only verification of an OPERATOR-PROVIDED, previously RESTORED archive.
# Run only with the project PostGIS container started, before migrations.
# This script never creates/overwrites/restores a database or prints its data.
fail() { printf 'BLOCKED backup gate: %s\n' "$1" >&2; exit 2; }

[[ $# -eq 0 ]] || fail "arguments are not accepted"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release="${SEDEAGRO_RELEASE_SHA:-}"
backup="${SEDEAGRO_VERIFIED_BACKUP_FILE:-}"
expected="${SEDEAGRO_VERIFIED_BACKUP_SHA256:-}"

[[ "$release" =~ ^[0-9a-f]{40}$ ]] || fail "missing full approved release SHA"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "missing full SHA256 of verified backup"
[[ "${SEDEAGRO_RESTORE_APPROVAL:-}" == "RESTORED:$release:$expected" ]] ||
  fail "operator must explicitly attest RESTORED:<release SHA>:<backup SHA256> after external restore"

for cmd in docker sha256sum stat realpath grep date; do
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

# Compose DB must already be running. Verify custom archive is readable with
# the pinned PostGIS pg_restore; never accept arbitrary SQL or apply a restore.
if ! archive_list="$(docker compose exec -T db pg_restore --list < "$backup")"; then
  fail "pg_restore cannot read archive TOC in the PostGIS container"
fi
for required in sequelize_migrations tenants auth_sessions fields work_orders evidence_blobs; do
  if ! grep -qF "$required" <<< "$archive_list"; then
    fail "backup missing expected schema object $required"
  fi
done

printf 'PASS read-only backup gate: recent private archive, matching SHA256 and pg_restore TOC for release %s.\n' "$release"
printf 'CAUTION: external restore verification is an operator attestation, not proved by this check.\n'