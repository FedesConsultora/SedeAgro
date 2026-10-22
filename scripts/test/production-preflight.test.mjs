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

const script = fileURLToPath(new URL('../production-preflight.sh', import.meta.url));
const source = readFileSync(script, 'utf8');
const securityScript = fileURLToPath(new URL('../verify-production-security.mjs', import.meta.url));
const securityCurrentPolicy = JSON.parse(readFileSync(new URL('../security-moderate-baseline.json', import.meta.url), 'utf8'));
const historicalUnacceptedPolicy = {
  ...securityCurrentPolicy, status:'unaccepted-for-release', maxModerate:2,
  packages:{sequelize:{version:'6.37.8',titles:[]},
    uuid:{version:'8.3.2',titles:['uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided']}}
};
const securityCurrentLock = JSON.parse(readFileSync(new URL('../../backend/package-lock.json', import.meta.url), 'utf8'));
const zeroRiskPolicy = { schema: 1, scope: 'backend-runtime', reviewBy: '2099-12-31', maxModerate: 0, status: 'remediated', packages: {} };
const safeSyntheticLock = { lockfileVersion: 3, packages: { '': { dependencies: { pg: '^8.13.1' } }, 'node_modules/pg': { version: '8.16.0' } } };

const rootEnv = [
  'POSTGRES_DB=sedeagro',
  'POSTGRES_USER=sedeagro_owner',
  'POSTGRES_PASSWORD=OwnerReleaseKey123456789abcdef',
  'APP_DB_USER=sedeagro_app',
  'APP_DB_PASSWORD=RuntimeReleaseKey123456789abcdef',
  ''
].join('\n');
const backendEnv = [
  'NODE_ENV=production',
  'SEED_MODE=prod',
  'LOG_SQL=0',
  'LOG_STACK=0',
  'BASE_DOMAIN=sedeagro.fedes.ai',
  'CORS_ORIGIN=https://sedeagro.fedes.ai',
  'JWT_SECRET=SyntheticJwtReleaseKey123456789abcdef',
  ''
].join('\n');

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 10000 });
}

function must(command, args, cwd) {
  const result = run(command, args, cwd);
  assert.equal(result.status, 0, command + ' ' + args.join(' ') + ': ' + result.stderr);
  return result.stdout.trim();
}

function fixture(t, releasePolicy = zeroRiskPolicy, releaseLock = safeSyntheticLock) {
  const work = mkdtempSync(join(tmpdir(), 'sedeagro-release-gate-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const root = join(work, 'repo');
  const origin = join(work, 'origin.git');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'backend'), { recursive: true });
  copyFileSync(script, join(root, 'scripts/production-preflight.sh'));
  copyFileSync(securityScript, join(root, 'scripts/verify-production-security.mjs'));
  writeFileSync(join(root, 'scripts/security-moderate-baseline.json'), JSON.stringify(releasePolicy));
  writeFileSync(join(root, 'backend/package-lock.json'), JSON.stringify(releaseLock));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, '.gitignore'), '.env\nbackend/.env\n');
  writeFileSync(join(root, 'README.md'), 'Synthetic disposable release fixture\n');
  writeFileSync(join(root, '.env'), rootEnv, { mode: 0o600 });
  writeFileSync(join(root, 'backend/.env'), backendEnv, { mode: 0o600 });
  chmodSync(join(root, '.env'), 0o600);
  chmodSync(join(root, 'backend/.env'), 0o600);
  must('git', ['init', '-b', 'main', '-q', root], work);
  must('git', ['-C', root, 'add', 'README.md', '.gitignore', 'package.json', 'backend/package-lock.json', 'scripts/production-preflight.sh', 'scripts/verify-production-security.mjs', 'scripts/security-moderate-baseline.json'], work);
  must('git', ['-C', root, '-c', 'user.name=ReleaseFixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial'], work);
  must('git', ['init', '--bare', '-q', origin], work);
  must('git', ['-C', root, 'remote', 'add', 'origin', origin], work);
  must('git', ['-C', root, 'push', '--quiet', '-u', 'origin', 'main'], work);
  const sha = must('git', ['-C', root, 'rev-parse', 'HEAD'], work);
  const env = { ...process.env,
    SEDEAGRO_RELEASE_SHA: sha, SEDEAGRO_DEPLOY_APPROVAL: 'DEPLOY:' + sha };
  const attempt = (overrides = {}, args = []) =>
    run('bash', [join(root, 'scripts/production-preflight.sh'), ...args],
      root, { ...env, ...overrides });
  return { root, origin, sha, attempt };
}

function rejected(attempt, reason = /BLOCKED production preflight/) {
  assert.equal(attempt.status, 2, attempt.stdout + attempt.stderr);
  assert.match(attempt.stderr, reason);
  assert.doesNotMatch(attempt.stdout, /PASS read-only/);
}

test('clean reviewed main and DEPLOY token are still blocked without signed image admission', (t) => {
  const { attempt, sha } = fixture(t);
  const result = attempt();
  rejected(result, /signed OCI\/security evidence directory is mandatory/);
  assert.doesNotMatch(result.stdout + result.stderr, /OwnerReleaseKey|RuntimeReleaseKey|SyntheticJwt/);
  assert.equal(sha.length, 40);
});

test('rejects an omitted, partial or mismatching SHA and incorrect approval', (t) => {
  const { attempt, sha } = fixture(t);
  rejected(attempt({ SEDEAGRO_RELEASE_SHA: '' }));
  rejected(attempt({ SEDEAGRO_RELEASE_SHA: sha.slice(0, 12) }));
  const mismatched = 'a'.repeat(40);
  rejected(attempt({ SEDEAGRO_RELEASE_SHA: mismatched,
    SEDEAGRO_DEPLOY_APPROVAL: 'DEPLOY:' + mismatched }));
  rejected(attempt({ SEDEAGRO_DEPLOY_APPROVAL: 'yes' }));
  rejected(attempt({}, ['--bypass']));
});

test('rejects a different branch and detached HEAD', (t) => {
  const { root, sha, attempt } = fixture(t);
  must('git', ['-C', root, 'switch', '-q', '-c', 'some-feature'], root);
  rejected(attempt());
  must('git', ['-C', root, 'switch', '-q', '--detach', sha], root);
  rejected(attempt());
});

test('rejects an uncommitted tracked edit', (t) => {
  const { root, attempt } = fixture(t);
  writeFileSync(join(root, 'README.md'), 'Dirty deployment\n');
  rejected(attempt(), /uncommitted/);
});

test('rejects a local main ahead of the approved remote SHA', (t) => {
  const { root, attempt, sha } = fixture(t);
  must('git', ['-C', root, '-c', 'user.name=ReleaseFixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm',
    'local drift'], root);
  const moved = must('git', ['-C', root, 'rev-parse', 'HEAD'], root);
  rejected(attempt({
    SEDEAGRO_RELEASE_SHA: moved, SEDEAGRO_DEPLOY_APPROVAL: 'DEPLOY:' + moved
  }), /origin\/main/);
  rejected(attempt({
    SEDEAGRO_RELEASE_SHA: sha, SEDEAGRO_DEPLOY_APPROVAL: 'DEPLOY:' + sha
  }), /local HEAD/);
});

test('rejects missing, symlinked or world-readable env files', (t) => {
  const { root, attempt } = fixture(t);
  const path = join(root, 'backend/.env');
  chmodSync(path, 0o644);
  rejected(attempt(), /chmod 600/);
  chmodSync(path, 0o600);
  rmSync(path);
  rejected(attempt(), /missing or a symlink/);
});

test('rejects demo seeds, debug logs and unsafe origin without executing config', (t) => {
  const { root, attempt } = fixture(t);
  const path = join(root, 'backend/.env');
  const original = readFileSync(path, 'utf8');
  for (const [before, after] of [
    ['SEED_MODE=prod', 'SEED_MODE=demo'],
    ['NODE_ENV=production', 'NODE_ENV=development'],
    ['LOG_SQL=0', 'LOG_SQL=1'],
    ['LOG_STACK=0', 'LOG_STACK=1'],
    ['CORS_ORIGIN=https://sedeagro.fedes.ai', 'CORS_ORIGIN=http://localhost:3000']
  ]) {
    writeFileSync(path, original.replace(before, after));
    rejected(attempt());
  }
  writeFileSync(path, original);
  rejected(attempt(), /signed OCI\/security evidence directory is mandatory/);
});

test('rejects weak secrets, shared DB users and duplicate configuration', (t) => {
  const { root, attempt } = fixture(t);
  const backendPath = join(root, 'backend/.env');
  const ownerPath = join(root, '.env');
  writeFileSync(backendPath, backendEnv.replace(
    'SyntheticJwtReleaseKey123456789abcdef', 'replace-with-production-secret'));
  rejected(attempt(), /JWT_SECRET/);
  writeFileSync(backendPath, backendEnv);
  writeFileSync(ownerPath, rootEnv.replace(
    'APP_DB_USER=sedeagro_app', 'APP_DB_USER=sedeagro_owner'));
  rejected(attempt(), /non-owner/);
  writeFileSync(ownerPath, rootEnv + 'APP_DB_PASSWORD=AnotherRuntimeReleaseKey123456789abcdef\n');
  rejected(attempt(), /duplicate/);
});

test('does not source or evaluate release-critical env values', (t) => {
  const { root, attempt } = fixture(t);
  const marker = join(root, 'unsafe-executed');
  const path = join(root, 'backend/.env');
  writeFileSync(path, backendEnv.replace(
    'SyntheticJwtReleaseKey123456789abcdef', '$(touch ' + marker + ')'));
  rejected(attempt());
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:source|\.)\s+.*\.env/m);
  assert.doesNotMatch(source, /\bdocker (?:compose|run|exec)\b/);
});

test('historical unaccepted moderate inventory refuses SHA-approved deploy', (t) => {
  const { attempt, sha } = fixture(t, historicalUnacceptedPolicy, securityCurrentLock);
  const out = attempt();
  rejected(out, /security P0 unresolved/);
  assert.match(out.stderr, /unresolved moderate advisories/);
  assert.doesNotMatch(out.stdout, /PASS read-only production preflight/);
  assert.equal(typeof sha, 'string');
});

test('synthetic remediated release must also eliminate every recorded vulnerable version', (t) => {
  const lock = structuredClone(safeSyntheticLock);
  lock.packages['node_modules/uuid'] = { version: '8.3.2' };
  const { attempt } = fixture(t, zeroRiskPolicy, lock);
  rejected(attempt(), /security P0 unresolved/);
});

test('real patched npm lock remains insufficient for release without attested images', t => {
  const { attempt } = fixture(t, securityCurrentPolicy, securityCurrentLock);
  rejected(attempt(), /signed OCI\/security evidence directory is mandatory/);
});

test('admission runs after secret/npm checks but before any production PASS or Docker', () => {
  const gate = source.indexOf('node "$ROOT/scripts/verify-production-image-admission.mjs"');
  const npm = source.indexOf('node "$ROOT/scripts/verify-production-security.mjs"');
  const pass = source.indexOf("printf 'PASS read-only production preflight:");
  assert.ok(npm >= 0 && gate > npm && pass > gate);
  assert.doesNotMatch(source, /(?:DEPLOY_APPROVAL|SKIP_GIT_PULL).*bypass/i);
});
