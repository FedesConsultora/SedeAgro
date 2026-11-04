// Read-only intake for MANUALLY witnessed mobile pilot acceptance.
// This validates records, NOT devices, attached evidence, or release approval.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const EVIDENCE = /^QA-[A-Z0-9][A-Z0-9-]{5,63}$/;
const ISSUE = /^#[1-9][0-9]{0,8}$/;
const DEVICE_DESCRIPTION = /^[a-zA-Z0-9._() /+-]{3,60}$/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const CASE_KEYS = ['case_id', 'device', 'status', 'tested_at',
  'device_profile', 'browser_version', 'evidence_ref', 'issue_ref'];
const ROOT_KEYS = ['schema', 'release_sha', 'staging_origin', 'cases'];
const SCHEMA = 'sedeagro-pilot-mobile-evidence-v1';
const PLATFORMS = ['android-chrome', 'ios-safari'];
const MATRIX = Object.freeze([
  ['MOB-01', 'android-chrome'],
  ['MOB-02', 'ios-safari'],
  ...Array.from({ length: 10 }, (_, index) => 'MOB-' + String(index + 3).padStart(2, '0'))
    .flatMap(id => PLATFORMS.map(device => [id, device]))
]);

function assert(condition) {
  if (!condition) throw new Error('PILOT_MOBILE_EVIDENCE_INVALID');
}
function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === expected.slice().sort().join('|');
}
function validOrigin(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && url.origin === input &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
function validRecentUtc(input, now) {
  if (typeof input !== 'string' || !UTC.test(input)) return false;
  const time = Date.parse(input);
  return Number.isFinite(time) && new Date(time).toISOString() ===
    input.replace('Z', '.000Z') && time <= now + 5 * 60_000 &&
    time >= now - 14 * 24 * 60 * 60_000;
}
function validDeviceDescription(input) {
  return typeof input === 'string' && DEVICE_DESCRIPTION.test(input);
}
function keyOf(item) {
  return item.case_id + '/' + item.device;
}
function validateCase(item, now, allowed) {
  assert(exactKeys(item, CASE_KEYS));
  assert(allowed.has(keyOf(item)) &&
    ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(item.status));
  if (item.status === 'PASS' || item.status === 'FAIL') {
    assert(validRecentUtc(item.tested_at, now) &&
      validDeviceDescription(item.device_profile) &&
      validDeviceDescription(item.browser_version) &&
      typeof item.evidence_ref === 'string' && EVIDENCE.test(item.evidence_ref));
    assert(item.status === 'FAIL' ? ISSUE.test(item.issue_ref) : item.issue_ref === null);
  } else {
    // A blocked or unexecuted test cannot carry an invented test timestamp.
    assert(item.tested_at === null && item.device_profile === null &&
      item.browser_version === null && item.evidence_ref === null);
    assert(item.status === 'BLOCKED' ? ISSUE.test(item.issue_ref) : item.issue_ref === null);
  }
}

export function pilotMobileTemplate(releaseSha, stagingOrigin) {
  assert(SHA.test(releaseSha || '') && validOrigin(stagingOrigin));
  return {
    schema: SCHEMA, release_sha: releaseSha, staging_origin: stagingOrigin,
    cases: MATRIX.map(([case_id, device]) => ({
      case_id, device, status: 'NOT_RUN', tested_at: null,
      device_profile: null, browser_version: null,
      evidence_ref: null, issue_ref: null
    }))
  };
}

export function inspectPilotMobileEvidence(document, { expectedSha, now = Date.now() } = {}) {
  assert(exactKeys(document, ROOT_KEYS) && SHA.test(expectedSha || '') &&
    document.schema === SCHEMA && document.release_sha === expectedSha &&
    validOrigin(document.staging_origin) &&
    Array.isArray(document.cases) && document.cases.length <= MATRIX.length &&
    Number.isFinite(now) && now > 0);
  const allowed = new Set(MATRIX.map(([id, device]) => id + '/' + device));
  const seen = new Set();
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const item of document.cases) {
    validateCase(item, now, allowed);
    const key = keyOf(item);
    assert(!seen.has(key));
    seen.add(key);
    counts[item.status] += 1;
  }
  const missing = [...allowed].filter(key => !seen.has(key));
  const status = counts.FAIL || counts.BLOCKED ? 'BLOCKED' :
    counts.NOT_RUN || missing.length ? 'INCOMPLETE' : 'COMPLETE_FOR_HUMAN_REVIEW';
  return {
    schema: SCHEMA, release_sha: expectedSha, status, counts, missing,
    required_cases: MATRIX.length, evidence_verified: false,
    device_verified: false, human_review_required: true, production_go: false
  };
}

function main(args) {
  if (args.length === 5 && args[0] === '--template' &&
      args[1] === '--sha' && args[3] === '--origin') {
    console.log(JSON.stringify(pilotMobileTemplate(args[2], args[4]), null, 2));
    return;
  }
  if (args.length !== 4 || args[0] !== '--file' || args[2] !== '--sha') {
    throw new Error('INVALID_ARGS');
  }
  const source = args[1];
  const size = statSync(source).size;
  assert(size > 0 && size <= 64 * 1024);
  const record = JSON.parse(readFileSync(source, 'utf8'));
  const result = inspectPilotMobileEvidence(record, { expectedSha: args[3] });
  console.log(JSON.stringify(result, null, 2));
  console.log('Evidencia declarada sin autenticación criptográfica: NO es certificación física ni GO.');
  if (result.status !== 'COMPLETE_FOR_HUMAN_REVIEW') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(process.argv.slice(2)); }
  catch {
    // No echo of paths, case payloads, credentials or internal evidence links.
    console.error('BLOCKED: expediente MOB inválido, excedido o de otro SHA.');
    process.exitCode = 2;
  }
}
