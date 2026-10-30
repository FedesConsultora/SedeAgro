import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needsReviewReceiptLookup, reconcileReviewReceipt } from '../src/services/workOrderReviewReceipt.js';

const checklist = Object.freeze({
  time_checked: true, area_checked: true, result_checked: true,
  operation_checked: true, evidence_basis: 'reviewed_files'
});
const reviewedAt = '2026-10-30T20:00:00.000Z';
const base = {
  id: 'report-1', work_order_id: 'order-1', submitted_by: 'worker-1',
  review_status: 'verified', reviewed_by: 'coordinator-1',
  reviewed_at: reviewedAt, review_checklist: { ...checklist }, review_note: null
};
const detail = (reports, attrs = {}) => ({
  data: { id: 'order-1', status: 'in_progress', WorkOrderAssignees: [],
    WorkOrderExecutions: reports, ...attrs }
});
const reconcile = (response, values = {}) => reconcileReviewReceipt(response, {
  orderId: 'order-1', reportId: 'report-1', reviewerId: 'coordinator-1',
  decision: 'verified', checklist, ...values
});

test('only uncertain HTTP outcomes or a specific already-reviewed conflict trigger a GET', () => {
  for (const error of [null, new TypeError('Failed to fetch'), { status: 0 },
    { status: 500 }, { status: 502 }, { status: 503 }, { status: 504 },
    { status: 409, code: 'EXECUTION_ALREADY_REVIEWED' },
    { status: 409, code: 'EXECUTION_REVIEW_CLOSED' }]) {
    assert.equal(needsReviewReceiptLookup(error), true, String(error?.status));
  }
  for (const error of [{ status: 400 }, { status: 401 }, { status: 403 },
    { status: 404 }, { status: 422 }, { status: 409, code: 'OTHER_CONFLICT' }]) {
    assert.equal(needsReviewReceiptLookup(error), false, String(error.status));
  }
});

test('exact persisted reviewer, report ID, decision and structured checklist confirm only that administrative review', () => {
  const result = reconcile(detail([base]));
  assert.equal(result.state, 'recorded');
  assert.equal(result.reportId, 'report-1');
  assert.equal(reconcile(detail([base]), { reviewerId: 'some-other-user' }).state, 'different');
  for (const changes of [
    { reviewed_by: 'other-user' }, { review_status: 'rejected' },
    { review_checklist: { ...checklist, evidence_basis: 'no_files' } },
    { review_checklist: { ...checklist, time_checked: false } },
    { review_checklist: null }, { reviewed_at: null }, { reviewed_at: 'invalid' }
  ]) {
    assert.equal(reconcile(detail([{ ...base, ...changes }])).state, 'different', JSON.stringify(changes));
  }
  assert.equal(reconcile(detail([{ ...base, review_status: 'submitted' }])).state, 'unconfirmed');
  assert.equal(reconcile(detail([])).state, 'unconfirmed');
});

test('a rejected part is only acknowledged with exact reviewer and reason; no checklist is inferred', () => {
  const rejected = { ...base, review_status: 'rejected', review_checklist: null,
    review_note: 'No coinciden los resultados declarados.' };
  const params = { decision: 'rejected', checklist: undefined,
    reason: 'No coinciden los resultados declarados.' };
  assert.equal(reconcile(detail([rejected]), params).state, 'recorded');
  assert.equal(reconcile(detail([rejected]), { ...params, reason: 'Otro motivo válido.' }).state, 'different');
  assert.equal(reconcile(detail([rejected]), { ...params, reviewerId: 'someone-else' }).state, 'different');
  assert.equal(reconcile(detail([rejected]), { ...params, reason: 'short' }).state, 'different');
});

test('foreign, duplicated and malformed server detail cannot confirm a mutation', () => {
  assert.throws(() => reconcile(detail([base], { id: 'order-other' })), /detalle de orden inválido/);
  assert.throws(() => reconcile(detail([{ ...base, work_order_id: 'other' }])), /historial de partes válido/);
  assert.throws(() => reconcile(detail([base, { ...base }])), /ambiguo/);
  assert.throws(() => reconcile({ data: { id: 'order-1', status: 'in_progress',
    WorkOrderAssignees: [] } }), /historial de partes válido/);
  assert.throws(() => reconcile(detail([base]), { reviewerId: '' }), /Faltan datos/);
});

test('UI blocks repeat POST while confirmation is uncertain and uses an authorized GET', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /setPendingReview\(pending\)/);
  assert.match(ui, /await verifyInterruptedReview\(pending\)/);
  assert.match(ui, /reconcileReviewReceipt\(response, \{/);
  assert.match(ui, /needsReviewReceiptLookup\(err\)/);
  assert.match(ui, /\|\| pendingReview\) return/);
  assert.match(ui, /disabled=\{busy \|\| Boolean\(pendingReview\)\}/);
  assert.match(ui, /Comprobar revisión en servidor/);
  assert.match(ui, /No se volvió a enviar/i);
});
