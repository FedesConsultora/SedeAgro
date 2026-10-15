import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const shell = new URL('../ci-disposable-restore.sh', import.meta.url);
const source = readFileSync(shell, 'utf8');
const minimal = { PATH: process.env.PATH || '/usr/bin:/bin' };
const valid = {
  ...minimal, CI: 'true', GITHUB_ACTIONS: 'true',
  SEDEAGRO_DISPOSABLE_RESTORE: 'I_ACCEPT_ONLY_CI_TEST_DATABASES'
};
function invoke(args, env) {
  return spawnSync('bash', [shell.pathname, ...args], {
    encoding: 'utf8', env, timeout: 10000
  });
}

test('requires all three independent CI-only conditions', () => {
  for (const omitted of ['CI', 'GITHUB_ACTIONS', 'SEDEAGRO_DISPOSABLE_RESTORE']) {
    const env = { ...valid };
    delete env[omitted];
    const attempt = invoke(['--check-only'], env);
    assert.equal(attempt.status, 2, omitted);
    assert.match(attempt.stderr, /BLOCKED/);
  }
  assert.equal(invoke(['--check-only'], {
    ...valid, SEDEAGRO_DISPOSABLE_RESTORE: '1'
  }).status, 2);
});

test('dry gate has no Docker or database side effects', () => {
  const result = invoke(['--check-only'], valid);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no database or Docker operation performed/);
  assert.doesNotMatch(result.stdout, /postgres:\/\//);
});

test('rejects arbitrary options, user-configurable database URLs and malformed CI IDs', () => {
  assert.equal(invoke(['--run', '--dbname=production'], valid).status, 2);
  assert.equal(invoke(['--run'], {
    ...valid, CI_POSTGIS_CONTAINER: 'prod',
    RESTORE_TEST_APP_PASSWORD: 'test-password-valid'
  }).status, 2);
  assert.equal(invoke(['--run'], {
    ...valid, CI_POSTGIS_CONTAINER: 'a'.repeat(64),
    RESTORE_TEST_APP_PASSWORD: 'bad:$\npassword'
  }).status, 2);
});

test('rehearsal uses fixed test DB, ephemeral backup, archive review and cleanup', () => {
  assert.match(source, /SOURCE_DB='sedeagro_test'/);
  assert.match(source, /RESTORED_DB='sedeagro_restore_test'/);
  assert.match(source, /image.*postgis\/postgis:16-3\.4/);
  assert.match(source, /mktemp -d/);
  assert.match(source, /umask 077/);
  assert.match(source, /pg_dump.*--format=custom --no-owner --no-acl/s);
  assert.match(source, /pg_restore --list/);
  assert.match(source, /--exit-on-error/);
  assert.match(source, /dropdb --if-exists/);
  assert.match(source, /trap cleanup EXIT/);
  assert.doesNotMatch(source, /docker compose (?:up|down)|deploy-prod\.sh/);
});

test('restored data requires matching migrations, FORCE RLS and full suite', () => {
  assert.match(source, /before="\$\(fingerprint "\$SOURCE_DB"\)"/);
  assert.match(source, /after="\$\(fingerprint "\$RESTORED_DB"\)"/);
  assert.match(source, /relforcerowsecurity/);
  assert.match(source, /provision-runtime-role\.sql/);
  assert.match(source, /npm --workspace backend run test:db/);
  assert.match(source, /TEST_DATABASE_APP_URL=/);
});
