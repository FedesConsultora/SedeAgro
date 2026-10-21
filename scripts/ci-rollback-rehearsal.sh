#!/usr/bin/env bash
set -Eeuo pipefail

# 0P.21 — deliberate dangerous-write-window rehearsal ONLY in GitHub Actions
# disposable PostGIS. Never an operational restore/deploy command.
fail() { printf 'BLOCKED CI rollback rehearsal: %s\n' "$1" >&2; exit 2; }
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true &&
   "${SEDEAGRO_DISPOSABLE_RESTORE:-}" == I_ACCEPT_ONLY_CI_TEST_DATABASES ]] ||
  fail 'GitHub disposable PostGIS approval required'
if [[ "$#" == 1 && "$1" == --check-only ]]; then
  echo 'PASS rollback rehearsal guard: no database or Docker operation performed.'
  exit 0
fi
[[ "$#" == 1 && "$1" == --run ]] || fail 'Usage: --check-only|--run'
container="${CI_POSTGIS_CONTAINER:-}"
[[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || fail 'CI PostGIS container ID required'
for cmd in docker node tr; do
  command -v "$cmd" >/dev/null 2>&1 || fail 'missing CI tool'
done
[[ "$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null)" == postgis/postgis:16-3.4 ]] ||
  fail 'not the CI PostGIS image'
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$root/scripts/sql/restore-data-fingerprint.sql" &&
   -f "$root/scripts/rollback-decision.mjs" ]] || fail 'missing immutable rehearsal prerequisites'
SOURCE_DB=sedeagro_test
BACKUP_DB=sedeagro_restore_test
OWNER=sedeagro_owner

sql() {
  # DO NOT expose the SQL to logs: fixture records are synthetic.
  docker exec "$container" psql -X -A -t -q -v ON_ERROR_STOP=1 \
    -U "$OWNER" -d "$SOURCE_DB" -c "$1" | tr -d '\r\n'
}
fingerprint() {
  docker exec -i "$container" psql -X -A -t -q -v ON_ERROR_STOP=1 \
    -U "$OWNER" -d "$1" -f - < "$root/scripts/sql/restore-data-fingerprint.sql" |
    tr -d '\r\n'
}
[[ "$(sql 'SELECT current_database()')" == "$SOURCE_DB" ]] || fail 'wrong source database'
[[ "$(docker exec "$container" psql -X -A -t -q -v ON_ERROR_STOP=1 -U "$OWNER" -d "$BACKUP_DB" -c 'SELECT current_database()' | tr -d '\r\n')" == "$BACKUP_DB" ]] ||
  fail 'wrong restored database'

base="$(fingerprint "$BACKUP_DB")"
[[ "$base" == "$(fingerprint "$SOURCE_DB")" ]] ||
  fail 'initial restored and source fingerprints are unequal'
migrations="$(docker exec "$container" psql -X -A -t -q -v ON_ERROR_STOP=1 \
  -U "$OWNER" -d "$SOURCE_DB" -c 'SELECT name FROM sequelize_migrations ORDER BY name' |
  tr -d '\r')"
[[ -n "$migrations" ]] || fail 'missing tracked migrations'

# The trap protects CI test state if any assertion fails mid-fixture.
tenant_inserted=0
plan_modified=0
cleanup() {
  local outcome=$?
  trap - EXIT
  if [[ "$plan_modified" == 1 ]]; then
    sql "UPDATE plans SET name=left(name,length(name)-length(' [0P21 CI]'))
      WHERE code='starter' AND right(name,length(' [0P21 CI]'))=' [0P21 CI]'" >/dev/null || outcome=1
  fi
  if [[ "$tenant_inserted" == 1 ]]; then
    sql "DELETE FROM tenants WHERE slug='0p21-ci-only-post-backup-write'" >/dev/null || outcome=1
  fi
  exit "$outcome"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check() {
  local scenario="$1" live="$2"
  SEDEAGRO_ROLLBACK_CI_MIGRATIONS="$migrations" \
    node --input-type=module - "$root" "$base" "$live" "$scenario" <<'NODE'
const [root, backup, current, scenario] = process.argv.slice(2);
const { assessRollbackEvidence } = await import('file://' + root + '/scripts/rollback-decision.mjs');
const migrations = process.env.SEDEAGRO_ROLLBACK_CI_MIGRATIONS.split('\n');
const e = {
  schema: 'sedeagro-rollback-review-v1',
  release: { current_sha:'a'.repeat(40), target_sha:'b'.repeat(40),
    backup_sha256:'c'.repeat(64) },
  database: {
    live_fingerprint:current, backup_fingerprint:backup,
    live_migrations:migrations, backup_migrations:migrations,
    target_code_migrations:[...migrations]
  },
  operations: {
    archive_sha256_verified:true, writes_quiesced:true,
    post_backup_writes_reconciled:true, offline_devices_inventory_complete:true,
    unknown_offline_devices:0, pending_offline_batches:0
  }
};
if (scenario === 'offline_unknown') e.operations.offline_devices_inventory_complete = false;
if (scenario === 'offline_pending') e.operations.pending_offline_batches = 1;
if (scenario === 'code_schema_drift') e.database.target_code_migrations.pop();
const result = assessRollbackEvidence(e);
const denied = result.database_restore.reason_codes.includes('RESTORE_DATA_DIVERGED');
if (scenario === 'live_parity') {
  if (result.database_restore.status !== 'OPERATOR_REVIEW_REQUIRED' ||
      result.code_only.status !== 'OPERATOR_REVIEW_REQUIRED' || result.certified) process.exit(1);
} else if (scenario === 'insert_post_backup' || scenario === 'same_count_update') {
  if (!denied || result.database_restore.status !== 'BLOCKED') process.exit(1);
} else if (scenario === 'offline_unknown' || scenario === 'offline_pending') {
  if (denied || result.database_restore.status !== 'BLOCKED') process.exit(1);
} else if (scenario === 'code_schema_drift') {
  if (result.code_only.status !== 'BLOCKED') process.exit(1);
} else {
  process.exit(1);
}
console.log('PASS disposable rollback admission scenario: ' + scenario +
  '; never an authorization to deploy/restore');
NODE
}

check live_parity "$base"
check offline_unknown "$base"
check offline_pending "$base"
check code_schema_drift "$base"

# A real COMMITTED post-backup insert must refuse restoring the old archive.
[[ "$(sql "SELECT count(*) FROM tenants WHERE slug='0p21-ci-only-post-backup-write'")" == 0 ]] ||
  fail 'disposable fixture already exists'
sql "INSERT INTO tenants (plan_id, name, slug, status)
  SELECT id, '0P21 Synthetic Write Window', '0p21-ci-only-post-backup-write', 'active'
  FROM plans WHERE code='starter'" >/dev/null
tenant_inserted=1
[[ "$(sql "SELECT count(*) FROM tenants WHERE slug='0p21-ci-only-post-backup-write'")" == 1 ]] ||
  fail 'synthetic tenant insert failed'
current="$(fingerprint "$SOURCE_DB")"
[[ "$current" != "$base" ]] || fail 'post-backup write incorrectly produced identical fingerprint'
check insert_post_backup "$current"
sql "DELETE FROM tenants WHERE slug='0p21-ci-only-post-backup-write'" >/dev/null
tenant_inserted=0
[[ "$(fingerprint "$SOURCE_DB")" == "$base" ]] ||
  fail 'fixture cleanup failed to restore original full contents/sequence state'

# Same-count edits can be missed by count-only backup comparisons.
[[ "$(sql "SELECT count(*) FROM plans WHERE code='starter' AND
   right(name,length(' [0P21 CI]'))=' [0P21 CI]'")" == 0 ]] || fail 'plan fixture collision'
sql "UPDATE plans SET name=name || ' [0P21 CI]' WHERE code='starter'" >/dev/null
plan_modified=1
current="$(fingerprint "$SOURCE_DB")"
[[ "${current%%|*}" == "${base%%|*}" && "$current" != "$base" ]] ||
  fail 'same-count update was not detected by full-row fingerprint'
check same_count_update "$current"
sql "UPDATE plans SET name=left(name,length(name)-length(' [0P21 CI]'))
  WHERE code='starter' AND right(name,length(' [0P21 CI]'))=' [0P21 CI]'" >/dev/null
plan_modified=0
[[ "$(fingerprint "$SOURCE_DB")" == "$base" ]] ||
  fail 'same-count update cleanup failed'
echo 'PASS CI-only rollback rehearsal: committed insert and same-count mutation blocked, clean baseline restored.'
