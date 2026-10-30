import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewRequestFingerprint } from '../src/modules/workOrders/reviewIdempotency.js';

const checklist = Object.freeze({
  time_checked: true, area_checked: true, result_checked: true,
  operation_checked: true, evidence_basis: 'no_files'
});
const fingerprint = (orderId, executionId, input) =>
  reviewRequestFingerprint({ orderId, executionId, input });

test('a review UUID identifies one exact order, report, decision and validated payload', () => {
  const accepted = { decision: 'verified', checklist };
  const baseline = fingerprint('order-1', 'execution-1', accepted);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint('order-1', 'execution-1', {
    ...accepted, checklist: { evidence_basis: 'no_files', operation_checked: true,
      result_checked: true, area_checked: true, time_checked: true }
  }), baseline, 'JSON input order does not alter a canonical fingerprint');
  for (const [orderId, executionId, input] of [
    ['order-2', 'execution-1', accepted],
    ['order-1', 'execution-2', accepted],
    ['order-1', 'execution-1', { ...accepted,
      checklist: { ...checklist, evidence_basis: 'reviewed_files' } }],
    ['order-1', 'execution-1', { decision: 'rejected',
      reason: 'No coincide el trabajo informado.' }],
    ['order-1', 'execution-1', { decision: 'rejected',
      reason: 'Motivo completamente diferente.' }]
  ]) assert.notEqual(fingerprint(orderId, executionId, input), baseline);
});

test('receipt reservation remains tenant/actor scoped and locked within original transaction', () => {
  const source = readFileSync(
    new URL('../src/modules/workOrders/reviewIdempotency.js', import.meta.url), 'utf8');
  const router = readFileSync(
    new URL('../src/modules/workOrders/router.js', import.meta.url), 'utf8');
  const migration = readFileSync(
    new URL('../db/migrations/202610300001_execution_review_requests.js', import.meta.url), 'utf8');
  assert.match(source, /ON CONFLICT \(tenant_id, reviewed_by, client_request_id\) DO NOTHING/);
  assert.match(source, /tenant_id=:tenant AND reviewed_by=:actor AND client_request_id=:key/);
  assert.match(source, /EXECUTION_REVIEW_REQUEST_CONFLICT/);
  assert.match(router, /await reserveExecutionReview\(req, report\)/);
  assert.match(router, /receipt.kind === 'replay'/);
  assert.match(router, /client_request_id: z.string\(\).uuid\(\).optional\(\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, reviewed_by, client_request_id\)/);
});
