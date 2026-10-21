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

test('content parity checks actual public rows and sequences before restored API tests', () => {
  const sql = readFileSync(new URL('../sql/restore-data-fingerprint.sql', import.meta.url), 'utf8');
  assert.match(source, /data_before="\\$\\(data_fingerprint "\\$SOURCE_DB"\\)"/);
  assert.match(source, /data_after="\\$\\(data_fingerprint "\\$RESTORED_DB"\\)"/);
  assert.match(source, /"\\$data_after" != "\\$data_before"/);
  assert.match(source, /restored application rows\\/sequence state differ/);
  assert.match(source, /restore-data-fingerprint\\.sql/);
  assert.match(sql, /current_database\\(\\) NOT IN/);
  assert.match(sql, /current_setting\\('is_superuser'\\)/);
  assert.match(sql, /CREATE TEMP TABLE/);
  assert.match(sql, /row_to_json\\(t\\)::text/);
  assert.match(sql, /string_agg\\(row_digest, '[^']*' ORDER BY row_digest\\)/);
  assert.match(sql, /last_value::text.*is_called::text/);
  assert.match(sql, /relispartition/);
  assert.match(sql, /pg_catalog\\.pg_depend/);
  assert.doesNotMatch(sql, /\\b(?:DROP DATABASE|TRUNCATE|DELETE FROM public|UPDATE public|CREATE TABLE public)\\b/i);
});

test('data fingerprint cannot run without explicit disposable database confirmation', () => {
  const sql = readFileSync(new URL('../sql/restore-data-fingerprint.sql', import.meta.url), 'utf8');
  assert.match(sql, /sedeagro_test/);
  assert.match(sql, /sedeagro_restore_test/);
  assert.match(sql, /RAISE EXCEPTION 'CI restore fingerprint refuses/);
  const check = invoke(['--check-only'], valid);
  assert.equal(check.status, 0, check.stderr);
  assert.doesNotMatch(check.stdout, /[a-f0-9]{32}/);
});
