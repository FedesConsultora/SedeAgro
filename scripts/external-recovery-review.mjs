// 0R.45: offline, read-only review of operator-supplied external recovery records.
// Never connects to a server, copies an archive, changes a database or grants GO.
// The record is not signed or independently attested: REVIEW_REQUIRED is the maximum.
import { constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const EVENTS = [
  'backup_consistent_until_at', 'outage_started_at', 'restore_started_at',
  'postgres_ready_at', 'api_ready_at', 'rollback_started_at', 'rollback_ready_at'
];
const REQUIRED_CHECKS = {
  utc_clocks_synced: 'CLOCKS_NOT_ATTESTED',
  archive_hash_verified: 'ARCHIVE_NOT_VERIFIED',
  restore_command_succeeded: 'RESTORE_NOT_VERIFIED',
  migrations_equal: 'MIGRATIONS_NOT_RECONCILED',
  row_and_sequence_fingerprints_equal: 'DATA_FINGERPRINT_NOT_RECONCILED',
  force_rls_verified: 'FORCE_RLS_NOT_VERIFIED',
  two_tenant_denial_verified: 'TENANT_DENIAL_NOT_VERIFIED',
  private_evidence_verified: 'PRIVATE_EVIDENCE_NOT_VERIFIED',
  application_authenticated_read_verified: 'APPLICATION_READ_NOT_VERIFIED',
  restored_state_isolated: 'RESTORE_ISOLATION_NOT_VERIFIED',
  post_backup_writes_reconciled: 'POST_BACKUP_WRITES_UNRECONCILED',
  offline_device_inventory_complete: 'OFFLINE_INVENTORY_INCOMPLETE'
};
function objectWithKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
    throw new Error('Unexpected evidence structure');
  }
  return value;
}
function timestamp(value, nowMs) {
  if (typeof value !== 'string' || !UTC.test(value)) {
    throw new Error('Non-canonical UTC timestamp');
  }
  const t = Date.parse(value);
  if (!Number.isFinite(t) || new Date(t).toISOString() !== value ||
      t > nowMs + 5 * 60_000) {
    throw new Error('Invalid or future recovery timestamp');
  }
  return t;
}
function exactHex(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('Invalid immutable identifier');
  }
}
function privateFile(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0') ||
      realpathSync(file) !== file) {
    throw new Error('Canonical absolute path required');
  }
  const parent = lstatSync(dirname(file));
  const leaf = lstatSync(file);
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      !leaf.isFile() || leaf.isSymbolicLink() ||
      (parent.mode & 0o077) || (leaf.mode & 0o077) ||
      (uid !== undefined && (parent.uid !== uid || leaf.uid !== uid)) ||
      leaf.size < 32 || leaf.size > 65536) {
    throw new Error('Private bounded operator evidence required');
  }
  // The CLI deliberately only reads a local, private JSON file.
  return JSON.parse(readFileSync(file, { encoding: 'utf8', flag: constants.O_RDONLY }));
}

export function assessExternalRecoveryEvidence(evidence, nowMs = Date.now()) {
  objectWithKeys(evidence, ['schema', 'release', 'placement', 'timeline', 'checks']);
  if (evidence.schema !== 'sedeagro-external-recovery-review-v1') {
    throw new Error('Unknown recovery evidence version');
  }
  const release = objectWithKeys(evidence.release, [
    'head_sha', 'backup_sha256', 'recovered_archive_sha256',
    'source_postgis_image', 'recovery_postgis_image'
  ]);
  exactHex(release.head_sha, HEX40);
  exactHex(release.backup_sha256, HEX64);
  exactHex(release.recovered_archive_sha256, HEX64);
  exactHex(release.source_postgis_image, IMAGE);
  exactHex(release.recovery_postgis_image, IMAGE);

  const placement = objectWithKeys(evidence.placement, [
    'source_host_fingerprint', 'recovery_host_fingerprint', 'backup_store_fingerprint'
  ]);
  for (const value of Object.values(placement)) exactHex(value, HEX64);
  const timeline = objectWithKeys(evidence.timeline, EVENTS);
  const times = EVENTS.map(event => timestamp(timeline[event], nowMs));
  if (times.some((time, index) => index > 0 && time < times[index - 1]) ||
      times[4] <= times[1] || times[6] <= times[5]) {
    throw new Error('Non-causal recovery timeline');
  }
  const checks = objectWithKeys(evidence.checks, [
    ...Object.keys(REQUIRED_CHECKS), 'pending_offline_batches', 'unknown_offline_devices'
  ]);
  const reasons = [];
  if (release.backup_sha256 !== release.recovered_archive_sha256) {
    reasons.push('BACKUP_HASH_MISMATCH');
  }
  if (release.source_postgis_image !== release.recovery_postgis_image) {
    reasons.push('POSTGIS_IMAGE_MISMATCH');
  }
  if (new Set(Object.values(placement)).size !== 3) {
    reasons.push('FAILURE_DOMAINS_NOT_DISTINCT');
  }
  for (const [name, code] of Object.entries(REQUIRED_CHECKS)) {
    if (typeof checks[name] !== 'boolean') {
      throw new Error('Explicit boolean operator evidence required');
    }
    if (!checks[name]) reasons.push(code);
  }
  for (const name of ['pending_offline_batches', 'unknown_offline_devices']) {
    if (!Number.isSafeInteger(checks[name]) || checks[name] < 0 || checks[name] > 1000000) {
      throw new Error('Invalid offline device inventory count');
    }
  }
  if (checks.pending_offline_batches > 0) reasons.push('OFFLINE_BATCHES_PENDING');
  if (checks.unknown_offline_devices > 0) reasons.push('OFFLINE_DEVICES_UNKNOWN');

  return {
    schema: 'sedeagro-external-recovery-assessment-v1',
    status: reasons.length ? 'BLOCKED' : 'OPERATOR_REVIEW_REQUIRED',
    reason_codes: reasons,
    measured_seconds: {
      rpo: (times[1] - times[0]) / 1000,
      rto: (times[4] - times[1]) / 1000,
      postgres_restore: (times[3] - times[2]) / 1000,
      rollback: (times[6] - times[5]) / 1000
    },
    certified: false,
    release_go: false,
    notice: 'OPERATOR_DATA_NOT_INDEPENDENTLY_ATTESTED; NO_EXTERNAL_RESTORE_CERTIFICATION_OR_DEPLOY_APPROVAL'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--evidence') {
      throw new Error('Expected --evidence absolute-private-json');
    }
    const result = assessExternalRecoveryEvidence(privateFile(process.argv[3]));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'BLOCKED' ? 2 : 0;
  } catch {
    // No input fields, paths, host fingerprints, hashes, or secrets in errors.
    console.error('BLOCKED external recovery review: invalid or unreadable evidence');
    process.exitCode = 2;
  }
}
