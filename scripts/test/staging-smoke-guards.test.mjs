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
const validCsp = [
  "default-src 'self'", "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "worker-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  "frame-ancestors 'none'", "upgrade-insecure-requests"
].join('; ');


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
    '  [[ "$arg" == --fail ]] && mode=body',
    '  [[ "$arg" == https://* ]] && url="$arg"',
    'done',
    'if [[ "$mode" == head ]]; then',
    '  echo "HTTP/2 ${MOCK_HEAD_STATUS:-200}"',
    '  if [[ "$MOCK_DOUBLE_STATUS" == 1 ]]; then echo "HTTP/1.1 200"; fi',
    '  echo "content-security-policy: $MOCK_CSP"',
    '  if [[ "$MOCK_DUPLICATE_CSP" == 1 ]]; then echo "content-security-policy: $MOCK_CSP"; fi',
    '  echo "referrer-policy: ${MOCK_REFERRER:-no-referrer}"',
    '  if [[ "$MOCK_DUPLICATE_REFERRER" == 1 ]]; then echo "referrer-policy: unsafe-url"; fi',
    '  echo "x-frame-options: ${MOCK_XFRAME:-DENY}"',
    '  if [[ "$MOCK_DUPLICATE_XFRAME" == 1 ]]; then echo "x-frame-options: SAMEORIGIN"; fi',
    '  echo "x-content-type-options: ${MOCK_XTYPE:-nosniff}"',
    '  if [[ "$MOCK_DUPLICATE_XTYPE" == 1 ]]; then echo "x-content-type-options: sniff"; fi',
    '  if [[ "$MOCK_NO_HSTS" != 1 ]]; then echo "strict-transport-security: ${MOCK_HSTS_VALUE:-max-age=$MOCK_HSTS_MAX}"; fi',
    '  if [[ "$MOCK_DUPLICATE_HSTS" == 1 ]]; then echo "strict-transport-security: max-age=0"; fi',
    '  exit 0',
    'fi',
    'case "$url" in',
    '  */health/revision) printf \'{"revision":"%s"}\\n\' "$MOCK_BACKEND_SHA" ;;',
    '  */health/ready) if [[ "$mode" == body ]]; then echo "$MOCK_READY_BODY"; else echo "$MOCK_READY_STATUS"; fi ;;',
    '  */health) if [[ "$mode" == body ]]; then echo "$MOCK_HEALTH_BODY"; else echo "$MOCK_HEALTH_STATUS"; fi ;;',
    '  */api/v1/auth/me) echo "$MOCK_AUTH_STATUS" ;;',
    '  *) echo 404 ;;',
    'esac',
    ''
  ].join('\n'), { mode: 0o700 });
  chmodSync(curl, 0o700);
  const env = { ...process.env, PATH: bin + ':' + (process.env.PATH || '/usr/bin:/bin'),
    MOCK_GIT_SHA: sha, MOCK_BACKEND_SHA: sha,
    MOCK_CSP: validCsp,
    MOCK_HSTS_MAX: '86400', MOCK_READY_STATUS: '200',
    MOCK_HEALTH_STATUS: '200',
    MOCK_HEALTH_BODY: '{"ok":true,"service":"sedeagro-backend"}',
    MOCK_READY_BODY: '{"ready":true}',
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
  assert.match(result.stdout, /backend SHA exacto/);
  assert.match(result.stdout, /El SHA verificado corresponde al checkout local/);
});

test('rejects missing or too-short HSTS and unavailable PostgreSQL', (t) => {
  const { attempt } = fixture(t);
  for (const override of [
    { MOCK_NO_HSTS: '1' },
    { MOCK_HSTS_MAX: '100' },
    { MOCK_READY_STATUS: '503' },
    { MOCK_BACKEND_SHA: 'b'.repeat(40) },
    { MOCK_BACKEND_SHA: 'not-available' },
    { MOCK_AUTH_STATUS: '200' }
  ]) {
    const result = attempt(override);
    assert.equal(result.status, 1, JSON.stringify(override) + ': ' + result.stderr);
    assert.doesNotMatch(result.stdout, /PASS staging/);
  }
});

test('rejects redirects, multiple status lines and wrong backend health JSON', (t) => {
  const { attempt } = fixture(t);
  for (const override of [
    { MOCK_HEAD_STATUS: '302' },
    { MOCK_HEAD_STATUS: '503' },
    { MOCK_DOUBLE_STATUS: '1' },
    { MOCK_HEALTH_STATUS: '404' },
    { MOCK_HEALTH_BODY: '<!doctype html><html>SPA fallback</html>' },
    { MOCK_HEALTH_BODY: '{"ok":true,"service":"other-backend"}' },
    { MOCK_READY_BODY: '{"ready":false}' },
    { MOCK_READY_BODY: '{"ready":true,"cached":true}' },
    { MOCK_READY_BODY: '<html>fallback</html>' }
  ]) {
    const result = attempt(override);
    assert.equal(result.status, 1, JSON.stringify(override) + ': ' + result.stderr);
    assert.doesNotMatch(result.stdout, /PASS staging/);
  }
});

test('rejects CSP allowing unsafe JavaScript, duplicate directives or missing isolation',t=>{
  const {attempt}=fixture(t);
  const cases=[
    validCsp.replace("script-src 'self'","script-src 'self' 'unsafe-inline'"),
    validCsp.replace("script-src 'self'","script-src 'self' 'unsafe-eval'"),
    validCsp.replace("script-src 'self'","script-src 'self' https:"),
    validCsp.replace("script-src 'self'","script-src *"),
    validCsp.replace("script-src 'self'","script-src 'self'; script-src 'self' 'unsafe-inline'"),
    validCsp.replace("object-src 'none'","object-src *"),
    validCsp.replace("frame-ancestors 'none'","frame-ancestors *"),
    validCsp.replace("base-uri 'self'","base-uri *"),
    validCsp.replace("form-action 'self'","form-action https:"),
    validCsp.replace("worker-src 'self'",""),
    validCsp.replace("connect-src 'self'",""),
    validCsp.replace("default-src 'self'","default-src *")
  ];
  for(const value of cases){
    const result=attempt({MOCK_CSP:value});
    assert.equal(result.status,1,result.stderr+' CSP='+value);
    assert.match(result.stderr,/headers inseguros o ambiguos/);
    assert.doesNotMatch(result.stdout,/PASS staging/);
  }
});

test('rejects ambiguous HSTS, duplicate security headers and diluted header values',t=>{
  const {attempt}=fixture(t);
  const bad=[
    {MOCK_HSTS_VALUE:'max-age=86400garbage'},
    {MOCK_HSTS_VALUE:'notmax-age=86400'},
    {MOCK_HSTS_VALUE:'max-age=0; max-age=86400'},
    {MOCK_HSTS_VALUE:'max-age=86400; includeSubDomains'},
    {MOCK_HSTS_VALUE:'max-age=99999999999999999999'},
    {MOCK_HSTS_VALUE:'max-age=00863'},
    {MOCK_DUPLICATE_HSTS:'1'},
    {MOCK_DUPLICATE_CSP:'1'},
    {MOCK_DUPLICATE_REFERRER:'1'},
    {MOCK_DUPLICATE_XFRAME:'1'},
    {MOCK_DUPLICATE_XTYPE:'1'},
    {MOCK_REFERRER:'unsafe-url'},
    {MOCK_XFRAME:'SAMEORIGIN'},
    {MOCK_XTYPE:'sniff'}
  ];
  for(const overrides of bad){
    const result=attempt(overrides);
    assert.equal(result.status,1,JSON.stringify(overrides)+' '+result.stderr);
    assert.match(result.stderr,/headers inseguros o ambiguos/);
  }
  const valid=attempt({MOCK_HSTS_VALUE:'MAX-AGE=86400'});
  assert.equal(valid.status,0,valid.stderr);
});

test('curl staging smoke is pinned to HTTPS without ambient curlrc, proxy or redirects', () => {
  const script = readFileSync(smokeScript, 'utf8');
  assert.match(script, /curl -q --silent --show-error/);
  assert.match(script, /--proto '=https' --noproxy '\*'/);
  assert.doesNotMatch(script, /--location|--insecure|curl -k/);
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
