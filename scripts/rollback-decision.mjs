// 0P.21: read-only rollback risk assessment. NO restore/deploy action exists here.
// Evidence is operator-supplied, not cryptographically attested by this program.
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^([1-9][0-9]{1,3})\|([0-9]{1,3})\|([a-f0-9]{32})$/;
const MIGRATION = /^[0-9]{12}_[a-z0-9_-]+\.js$/;

export function parseRollbackFingerprint(value) {
  const match = typeof value === 'string' ? FINGERPRINT.exec(value) : null;
  if (!match) throw new Error('Invalid rollback fingerprint');
  const tables = Number(match[1]);
  const sequences = Number(match[2]);
  if (!Number.isSafeInteger(tables) || tables < 20 || !Number.isSafeInteger(sequences)) {
    throw new Error('Incomplete rollback relation inventory');
  }
  return { tables, sequences, digest: match[3] };
}

function migrationInventory(value) {
  if (!Array.isArray(value) || value.length < 10 || value.length > 500 ||
      value.some(name => typeof name !== 'string' || !MIGRATION.test(name)) ||
      value.some((name, index) => index > 0 && name <= value[index - 1])) {
    throw new Error('Untrusted or incomplete migration inventory');
  }
  return value;
}

function requireBoolean(value) {
  if (typeof value !== 'boolean') throw new Error('Missing operator verification');
  return value;
}

export function assessRollbackEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      evidence.schema !== 'sedeagro-rollback-review-v1') {
    throw new Error('Unknown rollback evidence schema');
  }
  const release = evidence.release;
  const database = evidence.database;
  const operations = evidence.operations;
  if (!release || !database || !operations ||
      !SHA40.test(release.current_sha || '') ||
      !SHA40.test(release.target_sha || '') ||
      release.current_sha === release.target_sha ||
      !SHA256.test(release.backup_sha256 || '')) {
    throw new Error('Missing distinct exact release and archive identifiers');
  }

  // The fingerprint implementation hashes every application row, including
  // same-count changes, and sequence state. It is a comparison, not a MAC.
  const live = parseRollbackFingerprint(database.live_fingerprint);
  const backup = parseRollbackFingerprint(database.backup_fingerprint);
  const liveMigrations = migrationInventory(database.live_migrations);
  const backupMigrations = migrationInventory(database.backup_migrations);
  const candidateMigrations = migrationInventory(database.target_code_migrations);

  const archiveVerified = requireBoolean(operations.archive_sha256_verified);
  const writesStopped = requireBoolean(operations.writes_quiesced);
  const writesReviewed = requireBoolean(operations.post_backup_writes_reconciled);
  const inventoryComplete = requireBoolean(operations.offline_devices_inventory_complete);
  const unknownDevices = operations.unknown_offline_devices;
  const pending = operations.pending_offline_batches;
  if (!Number.isSafeInteger(unknownDevices) || unknownDevices < 0 ||
      !Number.isSafeInteger(pending) || pending < 0) {
    throw new Error('Missing offline device reconciliation counts');
  }

  const codeReasons = [];
  const restoreReasons = [];
  if (liveMigrations.join('\n') !== candidateMigrations.join('\n')) {
    codeReasons.push('CODE_SCHEMA_NOT_IDENTICAL');
  }
  if (backupMigrations.join('\n') !== candidateMigrations.join('\n')) {
    restoreReasons.push('RESTORE_SCHEMA_NOT_TARGET');
  }
  if (database.live_fingerprint !== database.backup_fingerprint ||
      live.tables !== backup.tables || live.sequences !== backup.sequences) {
    restoreReasons.push('RESTORE_DATA_DIVERGED');
  }
  if (!archiveVerified) restoreReasons.push('RESTORE_ARCHIVE_NOT_VERIFIED');
  if (!writesStopped) restoreReasons.push('RESTORE_WRITES_NOT_QUIESCED');
  if (!writesReviewed) restoreReasons.push('RESTORE_POST_BACKUP_WRITES_NOT_RECONCILED');
  if (!inventoryComplete || unknownDevices > 0) restoreReasons.push('RESTORE_OFFLINE_INVENTORY_UNKNOWN');
  if (pending > 0) restoreReasons.push('RESTORE_PENDING_OFFLINE_BATCHES');

  const status = reasons => reasons.length ? 'BLOCKED' : 'OPERATOR_REVIEW_REQUIRED';
  return {
    schema: 'sedeagro-rollback-assessment-v1',
    current_sha: release.current_sha,
    target_sha: release.target_sha,
    code_only: { status: status(codeReasons), reason_codes: codeReasons },
    database_restore: { status: status(restoreReasons), reason_codes: restoreReasons },
    certified: false,
    notice: 'NO_DEPLOY_OR_RESTORE_APPROVAL; preserve all post-backup writes and offline device data'
  };
}

function reviewFile(path) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Absolute evidence path required');
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768 || info.size < 32 ||
      (info.mode & 0o077) !== 0) {
    throw new Error('Evidence must be private, regular and bounded');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--evidence') {
      throw new Error('Expected one --evidence argument');
    }
    const verdict = assessRollbackEvidence(reviewFile(process.argv[3]));
    console.log(JSON.stringify(verdict));
    process.exitCode = verdict.code_only.status === 'BLOCKED' ||
      verdict.database_restore.status === 'BLOCKED' ? 2 : 0;
  } catch {
    // Never echo paths, PII, backup contents or configuration in a release gate.
    console.error('BLOCKED rollback review: invalid or unreadable evidence');
    process.exitCode = 2;
  }
}
