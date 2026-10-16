import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exceptionsForReport, canProposeException, canReviewExceptionUI,
  canVerifyWithExceptions, makeExceptionPayload, confirmException
} from '../src/services/inputException.js';

const order = { id: 'o1', status: 'in_progress' };
const report = { id: 'r1', submitted_by: 'worker', review_status: 'submitted' };
const catalog = [{ id: 'input1', name: 'Producto de prueba', unit: 'L' }];

test('only the report author may propose, and coordinator not author reviews', () => {
  assert.equal(canProposeException(order, report, 'worker', true), true);
  assert.equal(canProposeException(order, report, 'other', true), false);
  assert.equal(canProposeException(order, { ...report, review_status: 'verified' }, 'worker', true), false);
  assert.equal(canProposeException(order, report, 'worker', true, 8), false);
  assert.equal(canProposeException({ ...order, status: 'completed' }, report, 'worker', true), false);
  const exception = { submitted_by: 'worker', review_status: 'submitted', work_order_execution_id: 'r1' };
  assert.equal(canReviewExceptionUI(order, report, exception, 'tenant_admin', 'admin', true), true);
  assert.equal(canReviewExceptionUI(order, report, exception, 'agronomic_coordinator', 'coord', true), true);
  assert.equal(canReviewExceptionUI(order, report, exception, 'tenant_admin', 'worker', true), false);
  assert.equal(canReviewExceptionUI(order, report, exception, 'contractor', 'other', true), false);
});

test('new proposal binds catalog ID and does not coerce decimal quantities to float', () => {
  const body = makeExceptionPayload(catalog, 'input1', '0.7500',
    'Necesidad adicional informada en el campo.', 'uuid1');
  assert.deepEqual(body, {
    client_request_id: 'uuid1', input_id: 'input1',
    declared_quantity: '0.7500', reason: 'Necesidad adicional informada en el campo.'
  });
  assert.throws(() => makeExceptionPayload(catalog, 'unknown', '1', 'Motivo muy detallado', 'uuid'), /catálogo/);
  assert.throws(() => makeExceptionPayload(catalog, 'input1', '0', 'Motivo muy detallado', 'uuid'), /positiva/);
  assert.throws(() => makeExceptionPayload(catalog, 'input1', '1e2', 'Motivo muy detallado', 'uuid'), /positiva/);
  assert.throws(() => makeExceptionPayload(catalog, 'input1', '1', 'corta', 'uuid'), /10 y 500/);
});

test('new review is not inferred from submission or from a rejected record', () => {
  assert.deepEqual(exceptionsForReport([
    { work_order_execution_id: 'r1', review_status: 'approved' },
    { work_order_execution_id: 'r2', review_status: 'submitted' }
  ], 'r1'), [{ work_order_execution_id: 'r1', review_status: 'approved' }]);
  assert.equal(canVerifyWithExceptions([]), true);
  assert.equal(canVerifyWithExceptions([{ review_status: 'approved' }]), true);
  assert.equal(canVerifyWithExceptions([{ review_status: 'submitted' }]), false);
  assert.equal(canVerifyWithExceptions([{ review_status: 'rejected' }]), false);
  assert.throws(() => confirmException({ data: { id: 'x', work_order_execution_id: 'r2', review_status: 'approved' } },
    'r1'), /no confirmó/);
  assert.equal(confirmException({ data: { id: 'x', work_order_execution_id: 'r1',
    input_id: 'input1', review_status: 'approved' } }, 'r1', 'input1').id, 'x');
});

test('real panel mounts private async history and writes with exact confirmation', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderExecutionExceptions.jsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /execution-exceptions/);
  assert.match(ui, /unplanned-input-options/);
  assert.match(ui, /makeExceptionPayload\(options, inputId, quantity, reason, requestId\)/);
  assert.match(ui, /confirmException\(response/);
  assert.match(ui, /no se descuenta stock/);
  assert.match(panel, /<WorkOrderExecutionExceptions order=\{order\} reports=\{reports\}/);
});
