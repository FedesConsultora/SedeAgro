import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enforceModerateInventory } from '../security-moderate-policy.mjs';

const baseline = JSON.parse(readFileSync(
  new URL('../security-moderate-baseline.json', import.meta.url), 'utf8'));
const copy = value => structuredClone(value);
const makeLock = () => ({ lockfileVersion: 3, packages: Object.fromEntries(
  Object.entries(baseline.packages).map(([name, info]) =>
    ['node_modules/' + name, { version: info.version }])
) });
const makeSummary = () => ({
  scope: 'backend-runtime', moderate: baseline.maxModerate,
  affected: Object.entries(baseline.packages).map(([name, info]) => ({
    package: name, severity: 'moderate', via: [...info.titles],
    fixAvailable: true
  }))
});
const clock = new Date('2026-10-20T16:00:00.000Z');

test('actual checked-in inventory covers exact six reported moderately vulnerable packages', () => {
  const result = enforceModerateInventory(makeSummary(), baseline, makeLock(), clock);
  assert.equal(result.openModerate, 6);
  assert.equal(result.releaseAccepted, false);
  assert.equal(result.policy, 'inventory-only');
  assert.equal(result.reviewBy, '2026-11-20');
});

test('fixed vulnerabilities may disappear without triggering stale baseline failure', () => {
  const report = makeSummary();
  report.affected = report.affected.filter(item => item.package !== 'uuid');
  report.moderate = report.affected.length;
  assert.equal(enforceModerateInventory(report, baseline, makeLock(), clock).openModerate, 5);
  report.affected = []; report.moderate = 0;
  assert.equal(enforceModerateInventory(report, baseline, makeLock(), clock).openModerate, 0);
});

test('blocks newly affected package even when same six total remain', () => {
  const report = makeSummary();
  report.affected[0] = { package: 'unexpected-dep', severity: 'moderate', via: [] };
  assert.throws(() => enforceModerateInventory(report, baseline, makeLock(), clock),
    /new backend moderate advisory package/);
});

test('blocks increase in moderate count', () => {
  const report = makeSummary();
  report.affected.push({ package: 'unexpected-dep', severity: 'moderate', via: [] });
  report.moderate += 1;
  assert.throws(() => enforceModerateInventory(report, baseline, makeLock(), clock),
    /increased beyond reviewed inventory/);
});

test('blocks a version change to a vulnerable package even when name stays known', () => {
  const lock = makeLock(); lock.packages['node_modules/uuid'].version = '8.3.3';
  assert.throws(() => enforceModerateInventory(makeSummary(), baseline, lock, clock),
    /changed vulnerable dependency version/);
});

test('blocks newly published CVE on an already listed package', () => {
  const report = makeSummary();
  report.affected.find(item => item.package === 'uuid').via.push('Another upstream advisory');
  assert.throws(() => enforceModerateInventory(report, baseline, makeLock(), clock),
    /new\/modified upstream moderate advisory/);
});

test('blocks a newly direct-vulnerable transitive package previously only indirect', () => {
  const report = makeSummary();
  report.affected.find(item => item.package === 'argparse').via = ['New argparse advisory'];
  assert.throws(() => enforceModerateInventory(report, baseline, makeLock(), clock),
    /new\/modified upstream moderate advisory/);
});

test('incomplete or duplicate audit summaries cannot be waived', () => {
  const report = makeSummary(); report.affected.pop();
  assert.throws(() => enforceModerateInventory(report, baseline, makeLock(), clock),
    /incomplete moderate advisory list/);
  const duplicate = makeSummary(); duplicate.affected[1] = duplicate.affected[0];
  assert.throws(() => enforceModerateInventory(duplicate, baseline, makeLock(), clock),
    /duplicate moderate packages/);
});

test('review deadline expires fail-closed; valid through deadline UTC day', () => {
  const reviewDay = new Date('2026-11-20T23:59:59.000Z');
  assert.equal(enforceModerateInventory(makeSummary(), baseline, makeLock(), reviewDay).openModerate, 6);
  assert.throws(() => enforceModerateInventory(makeSummary(), baseline, makeLock(),
    new Date('2026-11-21T00:00:00.000Z')), /deadline expired/);
});

test('policy cannot accidentally mark open advisories as release accepted', () => {
  const changed = copy(baseline); changed.status = 'accepted';
  assert.throws(() => enforceModerateInventory(makeSummary(), changed, makeLock(), clock),
    /malformed backend moderate-vulnerability inventory/);
});

test('baseline cannot be changed to silently omit reviewed packages', () => {
  const changed = copy(baseline); delete changed.packages.uuid;
  assert.throws(() => enforceModerateInventory(makeSummary(), changed, makeLock(), clock),
    /invalid or unreviewed backend moderate-risk baseline/);
});

test('rejects untrusted lockfiles, invalid review dates and invalid clocks', () => {
  assert.throws(() => enforceModerateInventory(makeSummary(), baseline, {}, clock),
    /malformed backend moderate-vulnerability inventory/);
  const changed = copy(baseline); changed.reviewBy = '2026-02-30';
  assert.throws(() => enforceModerateInventory(makeSummary(), changed, makeLock(), clock),
    /malformed backend moderate-vulnerability inventory/);
  assert.throws(() => enforceModerateInventory(makeSummary(), baseline, makeLock(), new Date('invalid')),
    /malformed backend moderate-vulnerability inventory/);
});

test('formal remediated state requires zero MODERATE findings in live npm audit AND baseline', () => {
  const remediated = copy(baseline);
  remediated.status = 'remediated';
  remediated.packages = {};
  remediated.maxModerate = 0;
  const zero = makeSummary();
  zero.affected = [];
  zero.moderate = 0;
  const result = enforceModerateInventory(zero, remediated, makeLock(), clock);
  assert.deepEqual({ openModerate: result.openModerate, releaseAccepted: result.releaseAccepted,
    policy: result.policy }, { openModerate: 0, releaseAccepted: true, policy: 'remediated' });
  assert.throws(() => enforceModerateInventory(makeSummary(), remediated, makeLock(), clock),
    /remediated policy requires an empty LIVE advisory report/);
  const partial = copy(baseline);
  partial.status = 'remediated';
  partial.maxModerate = 6;
  assert.throws(() => enforceModerateInventory(makeSummary(), partial, makeLock(), clock),
    /remediated policy requires an empty LIVE advisory report/);
  const fake = copy(remediated);
  fake.packages.uuid = { version: '8.3.2', titles: [] };
  assert.throws(() => enforceModerateInventory(zero, fake, makeLock(), clock), /invalid or unreviewed/);
});

test('current real inventory is NEVER a release admission despite CI audit passing', () => {
  const report = makeSummary();
  assert.equal(enforceModerateInventory(report, baseline, makeLock(), clock).releaseAccepted, false);
  const dropped = copy(report);
  dropped.affected = [];
  dropped.moderate = 0;
  assert.equal(enforceModerateInventory(dropped, baseline, makeLock(), clock).releaseAccepted, false);
});
