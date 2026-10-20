// Read-only and fail-closed release gate. This verifies the reviewed repo
// security decision; live npm audit evidence MUST independently pass CI on
// the exact commit before any release. No CLI/env risk-acceptance bypass.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vulnerableVersions = Object.freeze({
  '@rushstack/ts-command-line': '4.19.1',
  argparse: '1.0.10',
  sequelize: '6.37.8',
  'sprintf-js': '1.0.3',
  umzug: '3.8.3',
  uuid: '8.3.2'
});

export function verifyProductionSecurity(policy, lock, today = new Date()) {
  if (!policy || policy.schema !== 1 || policy.scope !== 'backend-runtime' ||
      !policy.packages || typeof policy.packages !== 'object' ||
      Array.isArray(policy.packages) ||
      !Number.isSafeInteger(policy.maxModerate) ||
      !lock || lock.lockfileVersion !== 3 ||
      !lock.packages || typeof lock.packages !== 'object' ||
      Array.isArray(lock.packages) ||
      !lock.packages['']?.dependencies ||
      typeof lock.packages[''].dependencies !== 'object' ||
      !(today instanceof Date) || !Number.isFinite(today.getTime())) {
    throw new Error('BLOCKED: malformed release security decision or backend npm lockfile');
  }
  // This status may only be authored in a reviewed security-remediation PR
  // after a fresh scoped npm audit returns ZERO moderate/high/critical.
  if (policy.status !== 'remediated' || policy.maxModerate !== 0 ||
      Object.keys(policy.packages).length !== 0) {
    throw new Error('BLOCKED: unresolved moderate advisories; release security decision not remediated');
  }
  if (typeof policy.reviewBy !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(policy.reviewBy) ||
      !Number.isFinite(Date.parse(policy.reviewBy + 'T00:00:00Z')) ||
      new Date(policy.reviewBy + 'T00:00:00Z').toISOString().slice(0, 10) !== policy.reviewBy ||
      today.toISOString().slice(0, 10) > policy.reviewBy) {
    throw new Error('BLOCKED: production security review is expired or malformed');
  }
  // Defense in depth: rewriting the JSON policy alone cannot unlock a release
  // while the current known vulnerable package versions remain locked.
  for (const [name, version] of Object.entries(vulnerableVersions)) {
    if (lock.packages['node_modules/' + name]?.version === version) {
      throw new Error('BLOCKED: known vulnerable dependency still locked: ' + name);
    }
  }
  return { status: 'remediated', reviewBy: policy.reviewBy,
    checkedKnownVulnerableVersions: Object.keys(vulnerableVersions).length };
}

function main() {
  if (process.argv.length !== 4) {
    throw new Error('Usage: verify-production-security.mjs moderate-policy.json backend-package-lock.json');
  }
  const policy = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const lock = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const result = verifyProductionSecurity(policy, lock);
  console.log('PASS: production security release decision has zero open moderate baseline, known vulnerable versions absent; CI audit still required.');
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); }
  catch (error) {
    // Messages are sanitized and do not echo archive content or env secrets.
    console.error(String(error?.message || 'BLOCKED: invalid release security decision')
      .replace(/[^\w .:@/-]/g, ''));
    process.exitCode = 2;
  }
}
