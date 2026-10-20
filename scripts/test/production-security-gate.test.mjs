import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProductionSecurity } from '../verify-production-security.mjs';

const current = JSON.parse(readFileSync(new URL('../security-moderate-baseline.json', import.meta.url), 'utf8'));
const realLock = JSON.parse(readFileSync(new URL('../../backend/package-lock.json', import.meta.url), 'utf8'));
const clean = () => ({ schema: 1, scope: 'backend-runtime', status: 'remediated',
  reviewBy: '2099-12-31', maxModerate: 0, packages: {} });
const lock = () => ({ lockfileVersion: 3, packages: {
  '': { dependencies: { pg: '^8.13.1' } },
  'node_modules/pg': { version: '8.16.0' }
} });
const day = new Date('2026-10-20T16:00:00Z');

test('P0: actual six-moderate backend policy cannot authorize production', () => {
  assert.throws(() => verifyProductionSecurity(current, realLock, day),
    /unresolved moderate advisories/);
  const impersonate = structuredClone(current);
  impersonate.status = 'accepted';
  assert.throws(() => verifyProductionSecurity(impersonate, realLock, day),
    /not remediated/);
  impersonate.status = 'remediated';
  assert.throws(() => verifyProductionSecurity(impersonate, realLock, day),
    /not remediated/);
});

test('synthetic fully remediated baseline is technically admissible, not GO certification', () => {
  const verified = verifyProductionSecurity(clean(), lock(), day);
  assert.equal(verified.status, 'remediated');
  assert.equal(verified.checkedKnownVulnerableVersions, 6);
});

test('changing policy alone cannot hide known vulnerable versions', () => {
  for (const [name, version] of Object.entries({
    '@rushstack/ts-command-line': '4.19.1', argparse: '1.0.10',
    sequelize: '6.37.8', 'sprintf-js': '1.0.3',
    umzug: '3.8.3', uuid: '8.3.2'
  })) {
    const candidate = lock();
    candidate.packages['node_modules/' + name] = { version };
    assert.throws(() => verifyProductionSecurity(clean(), candidate, day),
      /known vulnerable dependency still locked/);
  }
});

test('a renamed, expired, unsigned-risk or malformed policy fails closed', () => {
  const examples = [
    { schema: 2 }, { scope: 'frontend-build' }, { status: 'accepted-without-review' },
    { maxModerate: 1 }, { packages: { uuid: { version: '8.3.2' } } },
    { reviewBy: '2026-10-19' }, { reviewBy: '2026-02-30' },
    { reviewBy: 'not-a-date' }
  ];
  for (const fragment of examples) {
    assert.throws(() => verifyProductionSecurity({ ...clean(), ...fragment }, lock(), day), /BLOCKED/);
  }
  assert.throws(() => verifyProductionSecurity(clean(), {}, day), /malformed/);
  assert.throws(() => verifyProductionSecurity(clean(), lock(), new Date(NaN)), /malformed/);
});

test('CLI rejects present real baseline in clean test, without opening DB or Docker', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'sedeagro-security-only-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const policyPath = join(folder, 'policy.json');
  const lockPath = join(folder, 'backend-lock.json');
  writeFileSync(policyPath, JSON.stringify(current));
  writeFileSync(lockPath, JSON.stringify(realLock));
  const out = spawnSync(process.execPath, [
    fileURLToPath(new URL('../verify-production-security.mjs', import.meta.url)),
    policyPath, lockPath
  ], { encoding: 'utf8', timeout: 5000 });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /BLOCKED/);
  assert.doesNotMatch(out.stdout, /PASS/);
  assert.doesNotMatch(out.stderr, /postgres:|JWT_SECRET|DATABASE_URL/);
});
