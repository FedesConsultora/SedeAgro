import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessExternalRecoveryEvidence } from '../external-recovery-review.mjs';

const script = fileURLToPath(new URL('../external-recovery-review.mjs', import.meta.url));
const at = '2026-11-11T00:00:00.000Z';
const now = Date.parse(at);
const stamp = '2026-11-10T';
const hex = char => char.repeat(64);
const expectedChecks = {
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
function fixture() {
  return {
    schema: 'sedeagro-external-recovery-review-v1',
    release: {
      head_sha: 'a'.repeat(40),
      backup_sha256: hex('b'),
      recovered_archive_sha256: hex('b'),
      source_postgis_image: 'sha256:' + hex('c'),
      recovery_postgis_image: 'sha256:' + hex('c')
    },
    placement: {
      source_host_fingerprint: hex('d'),
      recovery_host_fingerprint: hex('e'),
      backup_store_fingerprint: hex('f')
    },
    timeline: {
      backup_consistent_until_at: stamp + '00:00:00.000Z',
      outage_started_at: stamp + '00:02:00.000Z',
      restore_started_at: stamp + '00:04:00.000Z',
      postgres_ready_at: stamp + '00:07:00.000Z',
      api_ready_at: stamp + '00:08:00.000Z',
      rollback_started_at: stamp + '00:09:00.000Z',
      rollback_ready_at: stamp + '00:09:45.000Z'
    },
    checks: {
      ...Object.fromEntries(Object.keys(expectedChecks).map(k => [k, true])),
      pending_offline_batches: 0,
      unknown_offline_devices: 0
    }
  };
}
const review = e => assessExternalRecoveryEvidence(e, now);

test('RTO/RPO and rollback are computed from canonical observed UTC timestamps, never self-reported', () => {
  const result = review(fixture());
  assert.deepEqual(result.measured_seconds,
    {rpo: 120, rto: 360, postgres_restore: 180, rollback: 45});
  assert.equal(result.status, 'OPERATOR_REVIEW_REQUIRED');
  assert.equal(result.certified, false);
  assert.equal(result.release_go, false);
  assert.match(result.notice, /NO_EXTERNAL_RESTORE_CERTIFICATION/);
});

test('mismatched backup bytes, image version and shared failure domains block review', () => {
  const scenarios = [
    ['release', 'recovered_archive_sha256', hex('a'), 'BACKUP_HASH_MISMATCH'],
    ['release', 'recovery_postgis_image', 'sha256:' + hex('a'), 'POSTGIS_IMAGE_MISMATCH'],
    ['placement', 'recovery_host_fingerprint', hex('d'), 'FAILURE_DOMAINS_NOT_DISTINCT'],
    ['placement', 'backup_store_fingerprint', hex('e'), 'FAILURE_DOMAINS_NOT_DISTINCT']
  ];
  for (const [section, field, value, code] of scenarios) {
    const e = fixture();
    e[section][field] = value;
    const result = review(e);
    assert.equal(result.status, 'BLOCKED', field);
    assert.ok(result.reason_codes.includes(code), field);
    assert.equal(result.certified, false);
  }
});

test('each missing operational control is individually fail-closed', () => {
  for (const [field, code] of Object.entries(expectedChecks)) {
    const e = fixture();
    e.checks[field] = false;
    const result = review(e);
    assert.equal(result.status, 'BLOCKED', field);
    assert.ok(result.reason_codes.includes(code), field);
  }
  for (const [name, code] of [
    ['pending_offline_batches', 'OFFLINE_BATCHES_PENDING'],
    ['unknown_offline_devices', 'OFFLINE_DEVICES_UNKNOWN']
  ]) {
    const e = fixture();
    e.checks[name] = 2;
    assert.ok(review(e).reason_codes.includes(code));
  }
});

test('non-causal, nonexistent, non-UTC and future timestamp inputs fail', () => {
  const attempts = [
    ['outage_started_at', stamp + '00:00:01.000Z'],
    ['backup_consistent_until_at', stamp + '00:10:00.000Z'],
    ['api_ready_at', stamp + '00:03:59.000Z'],
    ['rollback_ready_at', stamp + '00:08:30.000Z'],
    ['rollback_ready_at', stamp + '00:09:00.000Z'],
    ['rollback_ready_at', '2026-11-12T00:00:00.000Z'],
    ['rollback_ready_at', '2026-02-30T00:00:00.000Z'],
    ['rollback_ready_at', '2026-11-10T00:09:45Z'],
    ['rollback_ready_at', '2026-11-10T00:09:45.000-03:00']
  ];
  for (const [field, value] of attempts) {
    const e = fixture();
    e.timeline[field] = value;
    assert.throws(() => review(e), undefined, field);
  }
});

test('unknown schemas, extra/omitted fields and weak immutable identifiers fail', () => {
  for (const corrupt of [
    e => {e.schema = 'v2';},
    e => {e.release.head_sha = 'abc';},
    e => {e.release.backup_sha256 = 'g'.repeat(64);},
    e => {e.release.source_postgis_image = 'postgis/postgis:latest';},
    e => {delete e.placement.backup_store_fingerprint;},
    e => {e.placement.secret = 'postgres://secret';},
    e => {e.timeline.extra = 'something';},
    e => {e.checks.extra = true;},
    e => {e.checks.utc_clocks_synced = 'true';},
    e => {delete e.checks.force_rls_verified;},
    e => {e.checks.unknown_offline_devices = -1;},
    e => {e.checks.pending_offline_batches = 0.5;},
    e => {e.checks.pending_offline_batches = null;}
  ]) {
    const e = fixture(); corrupt(e);
    assert.throws(() => review(e));
  }
});

function invoke(t, mutate = x => x, opts = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'sedeagro-external-review-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  chmodSync(folder, opts.publicParent ? 0o755 : 0o700);
  const file = join(folder, 'review.json');
  const evidence = mutate(fixture());
  writeFileSync(file, JSON.stringify(evidence || fixture()), {mode:0o600});
  if (opts.worldReadable) chmodSync(file, 0o644);
  const input = opts.symlink ? join(folder,'alias.json') : file;
  if (opts.symlink) symlinkSync(file, input);
  const args = [script, '--evidence', opts.relative ? 'relative.json' : input];
  if (opts.extraArg) args.push('--yes');
  return {
    file,
    result: spawnSync(process.execPath, args, {
      encoding:'utf8', timeout:4000, env:{PATH:process.env.PATH || '/usr/bin:/bin'}
    })
  };
}

test('CLI accepts only local private evidence and prints bounded review metrics', t => {
  const {result, file} = invoke(t);
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'OPERATOR_REVIEW_REQUIRED');
  assert.equal(JSON.parse(result.stdout).release_go,false);
  assert.doesNotMatch(result.stdout+result.stderr,/sha256:[a-f0-9]{64}|postgres:\/\/|sedeagro-external-review-/);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).schema,'sedeagro-external-recovery-review-v1');
});

test('CLI rejects blocked, unsafe, symlinked, public-parent and malformed evidence', t => {
  const runs = [
    () => invoke(t, e => {e.checks.restore_command_succeeded=false; return e;}),
    () => invoke(t, e => e, {worldReadable:true}),
    () => invoke(t, e => e, {symlink:true}),
    () => invoke(t, e => e, {publicParent:true}),
    () => invoke(t, e => e, {relative:true}),
    () => invoke(t, e => e, {extraArg:true})
  ];
  for (const execute of runs) {
    const {result} = execute();
    assert.equal(result.status,2,result.stderr);
    assert.doesNotMatch(result.stdout+result.stderr,/postgres:\/\/|sedeagro-external-review-/);
  }
});

test('source never invokes Docker, subprocesses, HTTP, restoration or SQL', () => {
  const source = readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /from 'node:(?:child_process|http|https|net)'/);
  assert.doesNotMatch(source, /(?:spawn|execFile|fetch|docker compose|pg_restore\s+--dbname)\(/);
});
