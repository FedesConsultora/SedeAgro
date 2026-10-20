import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, symlinkSync, utimesSync, writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('../verify-production-backup.sh', import.meta.url));
const release = 'a'.repeat(40);
const archiveData = Buffer.alloc(8192, 0x5a);

function fixture(t) {
  // Home directory avoids /tmp, which is explicitly forbidden by production.
  const work = mkdtempSync(join(homedir(), '.sedeagro-backup-gate-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const project = join(work, 'project');
  const dir = join(work, 'backups');
  const bin = join(work, 'bin');
  mkdirSync(join(project, 'scripts'), { recursive: true });
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  chmodSync(dir, 0o700);
  copyFileSync(sourceScript, join(project, 'scripts/verify-production-backup.sh'));
  const archive = join(dir, 'pre-release.dump');
  writeFileSync(archive, archiveData, { mode: 0o600 });
  chmodSync(archive, 0o600);
  const checksum = createHash('sha256').update(archiveData).digest('hex');
  const logFile = join(work, 'docker.calls');
  const mockDocker = join(bin, 'docker');
  const mock = [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$MOCK_DOCKER_LOG"',
    '[[ "$*" == "compose exec -T db pg_restore --list" ]] || exit 44',
    'if [[ "$MOCK_FAIL_DOCKER" == 1 ]]; then exit 55; fi',
    'cat >/dev/null',
    'if [[ "$MOCK_MISSING" == 1 ]]; then echo "TABLE public tenants"; exit 0; fi',
    'for table in sequelize_migrations tenants auth_sessions fields work_orders evidence_blobs; do',
    '  echo "TABLE public $table"',
    'done',
    ''
  ].join('\n');
  writeFileSync(mockDocker, mock, { mode: 0o700 });
  chmodSync(mockDocker, 0o700);
  const env = {
    ...process.env,
    PATH: bin + ':' + (process.env.PATH || '/usr/bin:/bin'),
    SEDEAGRO_RELEASE_SHA: release,
    SEDEAGRO_VERIFIED_BACKUP_FILE: archive,
    SEDEAGRO_VERIFIED_BACKUP_SHA256: checksum,
    SEDEAGRO_RESTORE_APPROVAL: 'RESTORED:' + release + ':' + checksum,
    MOCK_DOCKER_LOG: logFile
  };
  function attempt(overrides = {}, args = []) {
    return spawnSync('bash', [join(project, 'scripts/verify-production-backup.sh'), ...args],
      { cwd: project, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 });
  }
  return { work, project, dir, archive, checksum, logFile, attempt };
}

function blocked(result) {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED backup gate/);
  assert.doesNotMatch(result.stdout, /PASS read-only/);
}

test('accepts a recent private archive after matching digest, TOC and attestation', t => {
  const f = fixture(t);
  const result = f.attempt();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS read-only backup gate/);
  assert.match(readFileSync(f.logFile, 'utf8'), /compose exec -T db pg_restore --list/);
  assert.doesNotMatch(result.stdout, /private_password|localhost:5432/);
});

test('requires exact release, checksum and human-restored attestation', t => {
  const f = fixture(t);
  blocked(f.attempt({ SEDEAGRO_RELEASE_SHA: '' }));
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_SHA256: 'bad' }));
  blocked(f.attempt({ SEDEAGRO_RESTORE_APPROVAL: 'ok' }));
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_SHA256: 'b'.repeat(64),
    SEDEAGRO_RESTORE_APPROVAL: 'RESTORED:' + release + ':' + 'b'.repeat(64) }));
});

test('does not invoke Docker for rejected digest, approval or archive permissions', t => {
  const f = fixture(t);
  blocked(f.attempt({ SEDEAGRO_RESTORE_APPROVAL: 'yes' }));
  assert.equal(existsSync(f.logFile), false);
  chmodSync(f.archive, 0o644);
  blocked(f.attempt());
  assert.equal(existsSync(f.logFile), false);
  chmodSync(f.archive, 0o600);
  chmodSync(f.dir, 0o755);
  blocked(f.attempt());
  assert.equal(existsSync(f.logFile), false);
});

test('rejects symlinks, path traversal and backups under the checkout', t => {
  const f = fixture(t);
  const symlink = join(f.dir, 'link.dump');
  symlinkSync(f.archive, symlink);
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_FILE: symlink }));
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_FILE: f.dir + '/../backups/pre-release.dump' }));
  const inRepo = join(f.project, 'inside.dump');
  writeFileSync(inRepo, archiveData, { mode: 0o600 });
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_FILE: inRepo }));
});

test('rejects a backup older than 24h or unexpectedly small', t => {
  const f = fixture(t);
  const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
  utimesSync(f.archive, old, old);
  blocked(f.attempt());
  const recent = new Date();
  utimesSync(f.archive, recent, recent);
  writeFileSync(f.archive, Buffer.alloc(100));
  blocked(f.attempt());
});

test('fails closed if pg_restore fails or expected schema objects are absent', t => {
  const f = fixture(t);
  blocked(f.attempt({ MOCK_FAIL_DOCKER: '1' }));
  blocked(f.attempt({ MOCK_MISSING: '1' }));
  assert.match(readFileSync(f.logFile, 'utf8'), /pg_restore --list/);
});

test('rejects arbitrary arguments and does not mutate a database', t => {
  const f = fixture(t);
  blocked(f.attempt({}, ['--apply']));
  const source = readFileSync(sourceScript, 'utf8');
  assert.doesNotMatch(source, /docker compose (?:up|down|run)|\bpg_restore\s+--dbname/);
  assert.doesNotMatch(source, /\bpg_dump\b|\bDROP DATABASE\b/);
});
