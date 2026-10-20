import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const smokeScript = fileURLToPath(new URL('../verify-pilot-staging.sh', import.meta.url));
const sha = 'a'.repeat(40);

function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'sedeagro-staging-smoke-'));
  t.after(() => rmSync(tmp, { force: true, recursive: true }));
  const repo = join(tmp, 'repo');
  const bin = join(tmp, 'bin');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(smokeScript, join(repo, 'scripts/verify-pilot-staging.sh'));
  const git = join(bin, 'git');
  writeFileSync(git, [
    '#!/usr/bin/env bash',
    'echo "$MOCK_GIT_SHA"',
    ''
  ].join('\n'), { mode: 0o700 });
  chmodSync(git, 0o700);
  const curl = join(bin, 'curl');
  writeFileSync(curl, [
    '#!/usr/bin/env bash',
    'mode=status',
    'url=""',
    'for arg in "$@"; do',
    '  [[ "$arg" == --head ]] && mode=head',
    '  [[ "$arg" == https://* ]] && url="$arg"',
    'done',
    'if [[ "$mode" == head ]]; then',
    '  echo "HTTP/2 200"',
    '  echo "content-security-policy: default-src \u0027self\u0027; script-src \u0027self\u0027"',
    '  echo "referrer-policy: no-referrer"',
    '  echo "x-frame-options: DENY"',
    '  echo "x-content-type-options: nosniff"',
    '  if [[ "$MOCK_NO_HSTS" != 1 ]]; then echo "strict-transport-security: max-age=$MOCK_HSTS_MAX"; fi',
    '  exit 0',
    'fi',
    'case "$url" in',
    '  */health/ready) echo "$MOCK_READY_STATUS" ;;',
    '  */health) echo 200 ;;',
    '  */api/v1/auth/me) echo "$MOCK_AUTH_STATUS" ;;',
    '  *) echo 404 ;;',
    'esac',
    ''
  ].join('\n'), { mode: 0o700 });
  chmodSync(curl, 0o700);
  const env = { ...process.env, PATH: bin + ':' + (process.env.PATH || '/usr/bin:/bin'),
    MOCK_GIT_SHA: sha, MOCK_HSTS_MAX: '86400', MOCK_READY_STATUS: '200',
    MOCK_AUTH_STATUS: '401' };
  const attempt = (vars = {}, args = ['https://staging.example.test', sha]) =>
    spawnSync('bash', [join(repo, 'scripts/verify-pilot-staging.sh'), ...args],
      { cwd: repo, env: { ...env, ...vars }, encoding: 'utf8', timeout: 10000 });
  return { attempt };
}

test('staging smoke accepts validated HTTPS security headers and live DB readiness', (t) => {
  const { attempt } = fixture(t);
  const result = attempt();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /liveness\/readiness 200/);
  assert.match(result.stdout, /El SHA verificado corresponde al checkout local/);
});

test('rejects missing or too-short HSTS and unavailable PostgreSQL', (t) => {
  const { attempt } = fixture(t);
  for (const override of [
    { MOCK_NO_HSTS: '1' },
    { MOCK_HSTS_MAX: '100' },
    { MOCK_READY_STATUS: '503' },
    { MOCK_AUTH_STATUS: '200' }
  ]) {
    const result = attempt(override);
    assert.equal(result.status, 1, JSON.stringify(override) + ': ' + result.stderr);
    assert.doesNotMatch(result.stdout, /PASS staging/);
  }
});

test('requires explicit origin HTTPS, full SHA and matching local checkout', (t) => {
  const { attempt } = fixture(t);
  for (const args of [
    ['http://staging.example.test', sha],
    ['https://staging.example.test/path', sha],
    ['https://staging.example.test', sha.slice(0, 8)],
    ['https://secret@staging.example.test', sha],
    []
  ]) {
    const result = attempt({}, args);
    assert.equal(result.status, 2, JSON.stringify(args) + ': ' + result.stderr);
  }
  const mismatch = attempt({ MOCK_GIT_SHA: 'b'.repeat(40) });
  assert.equal(mismatch.status, 1, mismatch.stderr);
});

test('proxy passes HTTPS from edge only and production vhost declares HSTS', () => {
  const nginx = readFileSync(new URL('../../frontend/nginx.conf', import.meta.url), 'utf8');
  const edge = readFileSync(new URL('../../sedeagro.fedes.ai.conf', import.meta.url), 'utf8');
  assert.match(nginx, /map \$http_x_forwarded_proto \$sedeagro_upstream_proto/);
  assert.match(nginx, /https https;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$sedeagro_upstream_proto;/);
  assert.match(edge, /Strict-Transport-Security "max-age=86400" always/);
});
