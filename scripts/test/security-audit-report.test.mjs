import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeNpmAudit } from '../security-audit-report.mjs';

function audit({ critical = 0, high = 0, moderate = 0, low = 0, items = {} } = {}) {
  return { metadata: { vulnerabilities: { critical, high, moderate, low, info: 0, total: critical+high+moderate+low } },
    vulnerabilities: items };
}
test('accepts a complete clean npm audit report', () => {
  const summary = summarizeNpmAudit(audit(), 'backend-runtime');
  assert.equal(summary.blocked, false);
  assert.deepEqual(summary.affected, []);
});

test('fails closed on critical or high advisories with public package-only context', () => {
  const summary = summarizeNpmAudit(audit({
    critical: 1, high: 1,
    items: { pkg: { severity: 'critical', fixAvailable: { name: 'pkg', version: '2.0.0' },
      via: [{ title: 'Critical unsafe parser', url: 'https://example.test/security' }] },
      downstream: { severity: 'high', fixAvailable: false, via: ['pkg'] } }
  }), 'backend-runtime');
  assert.equal(summary.blocked, true);
  assert.equal(summary.critical, 1);
  assert.equal(summary.high, 1);
  assert.equal(summary.affected.length, 2);
  assert.ok(!JSON.stringify(summary).includes('https://example.test/security'));
  assert.ok(summary.affected.some(x => x.package === 'pkg' && x.fixAvailable));
});

test('moderate advisories stay visible without silently turning into a high-severity PASS', () => {
  const result = summarizeNpmAudit(audit({ moderate: 1, items: {
    parser: { severity: 'moderate', fixAvailable: true, via: [{ title: 'Review input parser handling' }] }
  } }), 'backend-runtime');
  assert.equal(result.blocked, false);
  assert.equal(result.moderate, 1);
  assert.deepEqual(result.affected.map(x => x.package), ['parser']);
});

test('rejects untrustworthy/incomplete audit reports rather than marking them green', () => {
  for (const payload of [
    null, {}, { error: { code: 'ENOTFOUND' } },
    { metadata: { vulnerabilities: { critical: 0, high: 0, low: 0 } }, vulnerabilities: {} },
    { metadata: { vulnerabilities: { critical: -1, high: 0, moderate: 0, low: 0 } }, vulnerabilities: {} }
  ]) {
    assert.throws(() => summarizeNpmAudit(payload, 'frontend-build'), /npm audit/);
  }
});

test('rejects malformed package names from remote audit response', () => {
  assert.throws(() => summarizeNpmAudit(audit({
    high: 1,
    items: { 'private token=secret': { severity: 'high', via: [] } }
  }), 'backend-runtime'), /Unsafe npm package/);
});
