import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import {
  reviewRecoveryScope, validReviewRecoveryBody,
  savePendingReview, readPendingReview
} from '../src/services/workOrderReviewRecoveryJournal.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';
const reviewer = '33333333-3333-4333-8333-333333333333';
const otherReviewer = '44444444-4444-4444-8444-444444444444';
const order = '55555555-5555-4555-8555-555555555555';
const otherOrder = '66666666-6666-4666-8666-666666666666';
const report = '77777777-7777-4777-8777-777777777777';
const requestId = '88888888-8888-4888-8888-888888888888';
const checklist = {
  time_checked: true, area_checked: true, result_checked: true,
  operation_checked: true, evidence_basis: 'no_files'
};
const session = (tenantId=tenant, userId=reviewer, role='tenant_admin', status='active') => ({
  authenticated: true, tenant: { id: tenantId }, user: { id: userId },
  membership: { roleCode: role, status }
});
const verified = {
  client_request_id: requestId, tenant_id: tenant, reviewer_id: reviewer,
  order_id: order, report_id: report, decision: 'verified', checklist
};

test('strict encrypted plaintext contract rejects foreign fields, incomplete checklists and ambiguous rejection', () => {
  assert.equal(validReviewRecoveryBody(verified), true);
  assert.equal(validReviewRecoveryBody({
    ...verified, decision: 'rejected', checklist: undefined
  }), false);
  assert.equal(validReviewRecoveryBody({
    client_request_id: requestId, tenant_id: tenant, reviewer_id: reviewer,
    order_id: order, report_id: report, decision: 'rejected',
    reason: 'Falta sustento de la superficie declarada.'
  }), true);
  for (const changed of [
    { ...verified, bearer: 'should-never-store' },
    { ...verified, checklist: { ...checklist, area_checked: false } },
    { ...verified, checklist: { ...checklist, evidence_basis: 'unreviewed' } },
    { ...verified, checklist: { ...checklist, secret: true } },
    { ...verified, report_id: 'other' },
    { ...verified, client_request_id: '' },
    { ...verified, checklist: null },
    { ...verified, reason: 'reason forbidden for acceptance' }
  ]) assert.equal(validReviewRecoveryBody(changed), false, JSON.stringify(changed));
  const rejection = { ...verified, decision: 'rejected',
    reason: 'La superficie no coincide.' };
  delete rejection.checklist;
  assert.equal(validReviewRecoveryBody(rejection), true);
  for (const reason of ['breve', ' Abcdefghijk ', 'x'.repeat(501)]) {
    assert.equal(validReviewRecoveryBody({ ...rejection, reason }), false);
  }
});

test('SHA-256 storage scope is stable, opaque and separated by server-authenticated tenant, user and order', async () => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  }
  const current = await reviewRecoveryScope(session(), order);
  assert.match(current, /^review:[0-9a-f]{64}$/);
  assert.equal(current, await reviewRecoveryScope(session(), order));
  assert.ok(!current.includes(tenant) && !current.includes(reviewer) && !current.includes(order));
  for (const candidate of [
    await reviewRecoveryScope(session(otherTenant), order),
    await reviewRecoveryScope(session(tenant, otherReviewer), order),
    await reviewRecoveryScope(session(), otherOrder)
  ]) assert.notEqual(candidate, current);
});

test('unverified accounts, inactive memberships, contractors and malformed UUIDs cannot inspect review slots', async () => {
  for (const input of [
    { ...session(), authenticated: false },
    session(tenant, reviewer, 'contractor'),
    session(tenant, reviewer, 'scout'),
    session(tenant, reviewer, 'tenant_admin', 'blocked'),
    session('not-a-uuid'),
    session(tenant, 'not-a-uuid'),
    session(tenant, reviewer, 'producer')
  ]) {
    await assert.rejects(reviewRecoveryScope(input, order), /sesión verificada/);
    await assert.rejects(readPendingReview(input, order), /sesión verificada/);
  }
  await assert.rejects(reviewRecoveryScope(session(), 'not-a-uuid'), /sesión verificada/);
});

test('missing IndexedDB fails closed instead of creating an untracked review POST', async () => {
  if (typeof indexedDB !== 'undefined') return;
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  }
  await assert.rejects(savePendingReview(session(), order, report, {
    client_request_id: requestId, decision: 'verified', checklist
  }), /IndexedDB no está disponible/);
});

test('React wiring waits for encrypted IDB commit and recovers with GET, never an automatic replay', () => {
  const panel = readFileSync(
    new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  const journal = readFileSync(
    new URL('../src/services/workOrderReviewRecoveryJournal.js', import.meta.url), 'utf8');
  assert.match(panel, /await savePendingReview\(session, order\.id, report\.id, body\)/);
  assert.match(panel, /await readPendingReview\(session, order\.id\)/);
  assert.match(panel, /await verifyInterruptedReview\(pending, \(\) => !cancelled\)/);
  assert.match(panel, /!reviewReady \|\| busy \|\| activePendingReview/);
  assert.match(panel, /body: sealed\.body/);
  assert.match(panel, /body: saved\.body/);
  assert.match(panel, /await discardPendingReview\(session, order\.id,/);
  assert.match(journal, /databaseName: 'sedeagro-work-order-review-recovery-v1'/);
  assert.match(journal, /crypto\.subtle\.digest\('SHA-256', input\)/);
  assert.doesNotMatch(journal, /localStorage|sessionStorage/);
});
