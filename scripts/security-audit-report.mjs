// Strict, bounded parser for npm audit --json from package-local lockfiles.
// Advisories and package names are public metadata, not secrets; never echo
// arbitrary npm output, registry credentials, request headers or stack traces.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enforceModerateInventory } from './security-moderate-policy.mjs';

export function summarizeNpmAudit(payload, scope) {
  if (!payload || typeof payload !== 'object' || payload.error ||
      !payload.metadata?.vulnerabilities ||
      !payload.vulnerabilities || typeof payload.vulnerabilities !== 'object' ||
      Array.isArray(payload.vulnerabilities)) {
    throw new Error('npm audit produced no trustworthy vulnerability report: ' + scope);
  }
  const counter = payload.metadata.vulnerabilities;
  const levels = ['critical', 'high', 'moderate', 'low'];
  if (levels.some(level => !Number.isSafeInteger(counter[level]) || counter[level] < 0)) {
    throw new Error('npm audit vulnerability counts are invalid: ' + scope);
  }
  const entries = Object.values(payload.vulnerabilities);
  const reported = Object.fromEntries(levels.map(level => [level, 0]));
  for (const item of entries) {
    if (!item || ![...levels, 'info'].includes(item.severity)) {
      throw new Error('npm audit returned an invalid advisory severity: ' + scope);
    }
    if (item.severity !== 'info') reported[item.severity] += 1;
  }
  if (levels.some(level => reported[level] !== counter[level])) {
    throw new Error('npm audit metadata disagrees with advisory inventory: ' + scope);
  }
  const affected = Object.entries(payload.vulnerabilities)
    .filter(([, item]) => ['critical', 'high', 'moderate'].includes(item?.severity))
    .map(([name, item]) => {
      if (!/^[a-zA-Z0-9@._/-]{1,150}$/.test(name)) {
        throw new Error('Unsafe npm package name in report');
      }
      const advisoryTitles = Array.isArray(item.via)
        ? item.via.filter(v => typeof v === 'object' && v !== null)
          .map(v => String(v.title || '').replace(/[^\w .,:;()/+\-]/g, '').slice(0, 110))
          .filter(Boolean).slice(0, 3)
        : [];
      return { package: name, severity: item.severity, via: advisoryTitles,
        fixAvailable: Boolean(item.fixAvailable) };
    }).sort((a, b) => a.package.localeCompare(b.package));
  if (affected.length > 80) {
    throw new Error('npm audit advisory inventory exceeded review limit: ' + scope);
  }
  return { scope, critical: counter.critical, high: counter.high,
    moderate: counter.moderate, low: counter.low,
    affected,
    blocked: counter.critical > 0 || counter.high > 0 };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length !== 4) {
    throw new Error('Usage: security-audit-report.mjs backend-audit.json frontend-audit.json backend-package-lock.json moderate-policy.json');
  }
  let blocked = false;
  let backendSummary;
  for (const [i, file] of files.slice(0, 2).entries()) {
    const scope = i === 0 ? 'backend-runtime' : 'frontend-build';
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const summary = summarizeNpmAudit(payload, scope);
    console.log(JSON.stringify(summary));
    if (i === 0) backendSummary = summary;
    blocked ||= summary.blocked;
  }
  const lock = JSON.parse(readFileSync(files[2], 'utf8'));
  const baseline = JSON.parse(readFileSync(files[3], 'utf8'));
  const inventory = enforceModerateInventory(backendSummary, baseline, lock);
  console.log(JSON.stringify(inventory));
  console.log('UNRESOLVED: moderate backend advisories require remediation or explicit GO risk acceptance.');
  if (blocked) {
    console.error('BLOCKED: high/critical npm advisory in production runtime or frontend build lock.');
    process.exitCode = 1;
  } else {
    console.log('PASS: no high/critical npm advisories or unexpected moderate drift in scoped audits.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); }
  catch (error) {
    console.error('BLOCKED: incomplete dependency security audit:', error.message);
    process.exitCode = 2;
  }
}
