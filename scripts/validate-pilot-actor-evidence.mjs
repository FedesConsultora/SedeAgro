// 0R.47: review operator-declared staging evidence for the existing six-principal
// HTTP pilot journey. Never contacts staging, authenticates evidence, or grants GO.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { readPrivateMobileEvidence } from './validate-pilot-mobile-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const EVIDENCE = /^QA-[A-Z0-9][A-Z0-9-]{5,63}$/;
const JOURNEY = /^QA-JOURNEY-[A-Z0-9-]{8,48}$/;
const ISSUE = /^#[1-9]\d{0,8}$/;
const SCHEMA = 'sedeagro-pilot-actor-evidence-v1';
const CASES = Object.freeze([
  ['ACT-01', 'tenant-admin-a', 201, 'create tenant via HTTP'],
  ['ACT-02', 'tenant-admin-a', 201, 'create GIS field and campaign assignment'],
  ['ACT-03', 'tenant-admin-a', 200, 'export one private reviewed field report'],
  ['ACT-04', 'agronomic-coordinator-a', 200, 'independently verify execution'],
  ['ACT-05', 'scout-a', 201, 'save GPS observation and private JPEG'],
  ['ACT-06', 'scout-a', 200, 'replay the same offline batch without duplication'],
  ['ACT-07', 'scout-a', 401, 'revoke prior cookie after membership block'],
  ['ACT-08', 'contractor-a', 201, 'submit assigned execution'],
  ['ACT-09', 'contractor-a', 403, 'deny self-review of execution'],
  ['ACT-10', 'producer-viewer-a', 200, 'read granted lots'],
  ['ACT-11', 'producer-viewer-a', 403, 'deny access to internal campaigns'],
  ['ACT-12', 'producer-viewer-a', 200, 'read empty lot list after revocation'],
  ['ACT-13', 'tenant-admin-b', 404, 'deny foreign tenant lot'],
  ['ACT-14', 'tenant-admin-b', 404, 'deny foreign private evidence'],
  ['ACT-15', 'tenant-admin-b', 404, 'deny foreign report']
]);
const ENTRY_KEYS = ['case_id', 'actor', 'status', 'http_status',
  'tested_at', 'evidence_ref', 'issue_ref'];
const ROOT_KEYS = ['schema', 'release_sha', 'staging_origin',
  'journey_ref', 'cases'];

function requireValue(condition) {
  if (!condition) throw new Error('INVALID_ACTOR_ACCEPTANCE_EVIDENCE');
}
function exactKeys(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === fields.slice().sort().join('|');
}
function safeStagingOrigin(input) {
  try {
    const url = new URL(input);
    return typeof input === 'string' && url.protocol === 'https:' &&
      url.origin === input && url.pathname === '/' &&
      !url.username && !url.password && !url.search && !url.hash &&
      isIP(url.hostname) === 0 && url.hostname.includes('.') &&
      /^[a-z0-9.-]+$/i.test(url.hostname) &&
      !url.hostname.endsWith('.localhost');
  } catch { return false; }
}
function recentUtc(value, now) {
  if (typeof value !== 'string' || !UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value.replace('Z', '.000Z') &&
    parsed <= now + 5 * 60_000 && parsed >= now - 14 * 86400_000;
}
const expected = new Map(CASES.map(([id, actor, httpStatus]) =>
  [id, { actor, httpStatus }]));

export function pilotActorTemplate(releaseSha, stagingOrigin, journeyRef) {
  requireValue(SHA.test(releaseSha || '') &&
    safeStagingOrigin(stagingOrigin) && JOURNEY.test(journeyRef || ''));
  return {
    schema: SCHEMA,
    release_sha: releaseSha,
    staging_origin: stagingOrigin,
    journey_ref: journeyRef,
    cases: CASES.map(([case_id, actor]) => ({
      case_id, actor, status: 'NOT_RUN',
      http_status: null, tested_at: null, evidence_ref: null, issue_ref: null
    }))
  };
}

export function inspectPilotActorEvidence(document, { expectedSha, now = Date.now() } = {}) {
  requireValue(exactKeys(document, ROOT_KEYS) &&
    document.schema === SCHEMA && SHA.test(expectedSha || '') &&
    document.release_sha === expectedSha &&
    safeStagingOrigin(document.staging_origin) &&
    JOURNEY.test(document.journey_ref) &&
    Number.isFinite(now) && now > 0 &&
    Array.isArray(document.cases) && document.cases.length <= CASES.length);

  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  const seenCases = new Set();
  const seenEvidence = new Set();
  const reasons = [];
  for (const record of document.cases) {
    requireValue(exactKeys(record, ENTRY_KEYS));
    const entry = expected.get(record.case_id);
    requireValue(entry && !seenCases.has(record.case_id) &&
      record.actor === entry.actor &&
      Object.hasOwn(counts, record.status));
    seenCases.add(record.case_id);
    counts[record.status] += 1;
    if (record.status === 'PASS' || record.status === 'FAIL') {
      requireValue(recentUtc(record.tested_at, now) &&
        Number.isInteger(record.http_status) &&
        record.http_status >= 100 && record.http_status <= 599 &&
        typeof record.evidence_ref === 'string' &&
        EVIDENCE.test(record.evidence_ref) &&
        !seenEvidence.has(record.evidence_ref));
      seenEvidence.add(record.evidence_ref);
      requireValue(record.status === 'PASS'
        ? record.issue_ref === null && record.http_status === entry.httpStatus
        : typeof record.issue_ref === 'string' && ISSUE.test(record.issue_ref));
      if (record.status === 'FAIL') reasons.push('DECLARED_FAILURE');
    } else {
      requireValue(record.tested_at === null && record.http_status === null &&
        record.evidence_ref === null &&
        (record.status === 'BLOCKED'
          ? typeof record.issue_ref === 'string' && ISSUE.test(record.issue_ref)
          : record.issue_ref === null));
      if (record.status === 'BLOCKED') reasons.push('DECLARED_BLOCKER');
    }
  }

  const missing = CASES.map(entry => entry[0]).filter(id => !seenCases.has(id));
  const status = reasons.length ? 'BLOCKED'
    : counts.NOT_RUN || missing.length ? 'INCOMPLETE'
      : 'COMPLETE_FOR_HUMAN_REVIEW';
  return {
    schema: 'sedeagro-pilot-actor-assessment-v1',
    release_sha: expectedSha,
    status, counts, missing,
    required_cases: CASES.length,
    distinct_principals: new Set(CASES.map(entry => entry[1])).size,
    staging_verified: false,
    evidence_verified: false,
    independent_review_required: true,
    production_go: false
  };
}

function main(args) {
  if (args.length === 7 &&
      args[0] === '--template' && args[1] === '--sha' &&
      args[3] === '--origin' && args[5] === '--journey') {
    console.log(JSON.stringify(pilotActorTemplate(args[2], args[4], args[6]), null, 2));
    return;
  }
  if (args.length !== 4 || args[0] !== '--file' || args[2] !== '--sha') {
    throw new Error('INVALID_ARGS');
  }
  // Reuse 0R.46's descriptor-bound private file intake, not a path-only read.
  const record = readPrivateMobileEvidence(args[1]);
  const result = inspectPilotActorEvidence(record, { expectedSha: args[3] });
  console.log(JSON.stringify(result));
  if (result.status !== 'COMPLETE_FOR_HUMAN_REVIEW') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch {
    // Never echo a private evidence path, case payload or user identity.
    console.error('BLOCKED pilot actor acceptance: invalid or unsafe evidence');
    process.exitCode = 2;
  }
}
