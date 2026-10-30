import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  needsExecutionReceiptLookup, reconcileExecutionReceipt
} from '../src/services/workOrderExecutionReceipt.js';

const payload = {
  started_at: '2026-10-30T10:30:00.000Z',
  finished_at: '2026-10-30T11:15:00.000Z',
  worked_area_hectares: 12.5,
  result_summary: 'Se completó la tarea declarada.'
};
const persisted = {
  id: 'report-1', work_order_id: 'order-1', submitted_by: 'user-1',
  started_at: '2026-10-30T07:30:00-03:00',
  finished_at: '2026-10-30T11:15:00Z',
  worked_area_hectares: '12.50',
  result_summary: payload.result_summary,
  review_status: 'submitted'
};
const serverDetail = (reports, fields = {}) => ({
  data: { id: 'order-1', status: 'in_progress', WorkOrderAssignees: [],
    WorkOrderExecutions: reports, ...fields }
});
const reconcile = result => reconcileExecutionReceipt(result, {
  orderId: 'order-1', actorId: 'user-1', payload
});

test('only uncertain transport or durable duplicate receipt conflict triggers GET reconciliation', () => {
  assert.equal(needsExecutionReceiptLookup({ status: 0 }), true);
  assert.equal(needsExecutionReceiptLookup(new TypeError('Failed to fetch')), true);
  assert.equal(needsExecutionReceiptLookup({ status: 409, code: 'EXECUTION_ALREADY_SUBMITTED' }), true);
  for (const e of [
    { status: 401 }, { status: 403 }, { status: 404 },
    { status: 409, code: 'OTHER_CONFLICT' }, { status: 422 }, { status: 503 }
  ]) assert.equal(needsExecutionReceiptLookup(e), false);
});

test('real serialized server report with UTC offsets and decimal string can confirm a matching record', () => {
  const result = reconcile(serverDetail([persisted]));
  assert.equal(result.state, 'recorded');
  assert.equal(result.reportId, persisted.id);
  assert.equal(reconcile(serverDetail([{ ...persisted, review_status: 'verified' }])).state, 'recorded');
  assert.equal(reconcile(serverDetail([{ ...persisted, review_status: 'rejected' }])).state, 'recorded');
});

test('never infer receipt from a foreign submitter, different payload, or malformed server detail', () => {
  const negatives = [
    { submitted_by: 'user-2' },
    { work_order_id: 'order-other' },
    { started_at: '2026-10-30T10:31:00Z' },
    { finished_at: '2026-10-30T11:16:00Z' },
    { worked_area_hectares: '12.51' },
    { result_summary: 'Otra declaración de trabajo.' },
    { review_status: 'unknown' },
    { id: null }
  ];
  for (const changes of negatives) {
    const altered = { ...persisted, ...changes };
    if (!altered.id || altered.work_order_id !== 'order-1') {
      assert.throws(() => reconcile(serverDetail([altered])), /historial de partes válido/);
    } else {
      const state = reconcile(serverDetail([altered])).state;
      assert.notEqual(state, 'recorded', JSON.stringify(changes));
    }
  }
  assert.equal(reconcile(serverDetail([])).state, 'unconfirmed');
  assert.equal(reconcile(serverDetail([{ ...persisted, submitted_by: 'other' }])).state, 'different');
  assert.equal(reconcile(serverDetail([persisted, { ...persisted, id: 'report-2' }])).state, 'ambiguous');
  assert.throws(() => reconcile(serverDetail([persisted], { id: 'different' })), /detalle de orden inválido/);
  assert.throws(() => reconcile({ data: { id: 'order-1', status: 'in_progress', WorkOrderAssignees: [] } }),
    /historial de partes válido/);
});

test('live UI never repeats POST automatically after ambiguous ACK and uses authorized GET', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /setPendingPayload\(body\)/);
  assert.match(ui, /await verifyInterruptedSubmission\(body\)/);
  assert.match(ui, /reconcileExecutionReceipt\(response, \{/);
  assert.match(ui, /method: 'POST', silent: true, body/);
  assert.match(ui, /Comprobar parte en servidor/);
  assert.match(ui, /Boolean\(pendingPayload\)/);
  assert.match(ui, /no se volvió a enviar/i);
});
