import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync,
  readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../verify-fresh-install-db.sh', import.meta.url));
const sha = 'a'.repeat(40);

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'sedeagro-fresh-db-'));
  t.after(() => rmSync(folder, { force: true, recursive: true }));
  const bin = join(folder, 'bin');
  mkdirSync(bin);
  const docker = join(bin, 'docker');
  writeFileSync(docker, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$MOCK_DOCKER_CALLS"',
    '[[ "$1" == compose && "$2" == exec && "$3" == -T && "$4" == db && "$5" == psql ]] || exit 60',
    '[[ "$MOCK_DB_FAIL" != 1 ]] || exit 61',
    'printf "%s\\n" "$MOCK_DB_FOOTPRINT"',
    ''
  ].join('\n'), { mode: 0o700 });
  chmodSync(docker, 0o700);
  const log = join(folder, 'docker.calls');
  const env = { ...process.env,
    PATH: bin + ':' + (process.env.PATH || '/usr/bin:/bin'),
    SEDEAGRO_RELEASE_SHA: sha,
    SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL: 'FIRST_DEPLOY:' + sha,
    POSTGRES_USER: 'sedeagro_owner', POSTGRES_DB: 'sedeagro',
    MOCK_DOCKER_CALLS: log, MOCK_DB_FOOTPRINT: '0|0',
    SEDEAGRO_VERIFIED_BACKUP_FILE: '',
    SEDEAGRO_VERIFIED_BACKUP_SHA256: '', SEDEAGRO_RESTORE_APPROVAL: ''
  };
  function attempt(overrides = {}, args = []) {
    return spawnSync('bash', [script, ...args], {
      cwd: folder, env: { ...env, ...overrides },
      encoding: 'utf8', timeout: 10000
    });
  }
  return { attempt, log };
}

function blocked(result) {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED initial bootstrap/);
  assert.doesNotMatch(result.stdout, /PASS read-only/);
}

test('allows only explicitly attested virgin database with extension-owned objects', t => {
  const f = fixture(t);
  const result = f.attempt();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS read-only fresh database gate/);
  assert.match(readFileSync(f.log, 'utf8'), /docker|psql|pg_class|pg_depend|pg_extension|pg_namespace|relkind/);
});

test('requires full release SHA, matching approval and safe identifiers', t => {
  const f = fixture(t);
  blocked(f.attempt({ SEDEAGRO_RELEASE_SHA: '' }));
  blocked(f.attempt({ SEDEAGRO_RELEASE_SHA: sha.slice(0, 10) }));
  blocked(f.attempt({ SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL: 'ok' }));
  blocked(f.attempt({ SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL: 'FIRST_DEPLOY:' + 'b'.repeat(40) }));
  blocked(f.attempt({ POSTGRES_USER: 'unsafe;drop table' }));
  blocked(f.attempt({ POSTGRES_DB: 'sedeagro-prod' }));
  blocked(f.attempt({}, ['--force']));
});

test('rejects ambiguity with ANY backup/restore approval input before DB access', t => {
  const f = fixture(t);
  for (const field of ['SEDEAGRO_VERIFIED_BACKUP_FILE',
    'SEDEAGRO_VERIFIED_BACKUP_SHA256', 'SEDEAGRO_RESTORE_APPROVAL']) {
    blocked(f.attempt({ [field]: 'given' }));
    assert.equal(existsSync(f.log), false);
  }
});

test('rejects previously migrated, half-created or unfamiliar DB objects', t => {
  const f = fixture(t);
  for (const count of ['1|0', '0|1', '45|2', '0|0\n0|0', '']) {
    blocked(f.attempt({ MOCK_DB_FOOTPRINT: count }));
  }
  blocked(f.attempt({ MOCK_DB_FAIL: '1' }));
});

test('script is read-only, checks extension membership, does not bypass RLS', () => {
  const source = readFileSync(script, 'utf8');
  const sql = readFileSync(new URL('../sql/first-install-footprint.sql', import.meta.url), 'utf8');
  assert.match(source, /first-install-footprint\.sql/);
  assert.match(sql, /pg_depend/);
  assert.match(sql, /pg_extension/);
  assert.match(sql, /pg_namespace/);
  assert.match(sql, /relkind IN/);
  assert.match(sql, /left\(n.nspname, 3\)/);
  assert.doesNotMatch(source, /\bdocker compose (?:up|down|run)\b/);
  assert.doesNotMatch(source + sql, /\bDROP\b|\bALTER\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|pg_dump|pg_restore/);
});
