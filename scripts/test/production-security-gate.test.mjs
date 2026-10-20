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

test('real remediated checked-in backend policy admits only pinned patched UUID', () => {
  const result = verifyProductionSecurity(current, realLock, day);
  assert.equal(result.status,'remediated');
  assert.equal(result.checkedKnownVulnerableVersions,5);
  const legacy = structuredClone(current);
  legacy.status = 'unaccepted-for-release';
  legacy.maxModerate=2;
  legacy.packages = { sequelize:{version:'6.37.8',titles:[]},
    uuid:{version:'8.3.2',titles:['uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided']} };
  assert.throws(() => verifyProductionSecurity(legacy,realLock,day),
    /unresolved moderate advisories/);
  const forged = structuredClone(realLock);
  forged.packages['node_modules/uuid'].version = '8.3.2';
  assert.throws(() => verifyProductionSecurity(current,forged,day),
    /known vulnerable dependency still locked/);
  const absent=structuredClone(realLock);
  delete absent.packages['node_modules/uuid'];
  assert.throws(() => verifyProductionSecurity(current,absent,day),
    /Sequelize requires exactly reviewed patched uuid/);
  const nested=structuredClone(realLock);
  nested.packages['node_modules/sequelize/node_modules/uuid']={version:'8.3.2'};
  assert.throws(() => verifyProductionSecurity(current,nested,day),/Sequelize requires/);
});

test('synthetic fully remediated baseline is technically admissible, not GO certification', () => {
  const verified = verifyProductionSecurity(clean(), lock(), day);
  assert.equal(verified.status, 'remediated');
  assert.equal(verified.checkedKnownVulnerableVersions, 5);
});

test('changing policy alone cannot hide known vulnerable versions', () => {
  for (const [name, version] of Object.entries({
    '@rushstack/ts-command-line': '4.19.1', argparse: '1.0.10',
    'sprintf-js': '1.0.3',
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

test('CLI admits the reviewed zero-moderate real lock without opening DB or Docker', (t) => {
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
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /PASS: production security release decision/);
  assert.doesNotMatch(out.stderr, /BLOCKED/);
  assert.doesNotMatch(out.stderr, /postgres:|JWT_SECRET|DATABASE_URL/);
});
