import test from 'node:test';
import assert from 'node:assert/strict';
import { positiveDeclaredQuantity, sameUnplannedRequest, canApproveWithExceptions,
  canReviewException, publicException, MAX_UNPLANNED_INPUTS
} from '../src/modules/workOrders/inputExceptionPolicy.js';

const context = { orderId: 'o1', executionId: 'e1', actorId: 'worker' };
const body = { client_request_id: 'uuid1', input_id: 'input1',
  declared_quantity: '0.7500', reason: 'Se requirió insumo adicional en el lote.' };
const existing = { client_request_id: 'uuid1', work_order_id: 'o1',
  work_order_execution_id: 'e1', submitted_by: 'worker', input_id: 'input1',
  quantity: '0.7500', reason: body.reason, review_status: 'submitted' };

test('new material exception accepts strictly positive decimal quantities, not a fake zero use', () => {
  assert.equal(positiveDeclaredQuantity('0.0001'), '0.0001');
  assert.equal(positiveDeclaredQuantity('0.7500'), '0.75');
  assert.equal(positiveDeclaredQuantity('99999999.9999'), '99999999.9999');
  for (const value of ['0', '0.0000', '-5', 'NaN', '1e3', '1.00000', '100000000']) {
    assert.throws(() => positiveDeclaredQuantity(value), /cantidad|Cantidad/i);
  }
});

test('UUID replays require exactly the same order, report, actor, material, amount and reason', () => {
  assert.equal(sameUnplannedRequest(existing, body, context), true);
  assert.equal(sameUnplannedRequest(existing, { ...body, client_request_id: 'uuid2' }, context), false);
  assert.equal(sameUnplannedRequest(existing, { ...body, input_id: 'input2' }, context), false);
  assert.equal(sameUnplannedRequest(existing, { ...body, declared_quantity: '0.80' }, context), false);
  assert.equal(sameUnplannedRequest(existing, { ...body, reason: 'Distinta nota válida' }, context), false);
  assert.equal(sameUnplannedRequest(existing, body, { ...context, executionId: 'e2' }), false);
  assert.equal(sameUnplannedRequest(existing, body, { ...context, actorId: 'other' }), false);
});

test('positive execution review rejects any unresolved or rejected material exception', () => {
  assert.equal(MAX_UNPLANNED_INPUTS, 8);
  assert.equal(canApproveWithExceptions([]), true);
  assert.equal(canApproveWithExceptions([{ review_status: 'approved' }]), true);
  assert.equal(canApproveWithExceptions([{ review_status: 'submitted' }]), false);
  assert.equal(canApproveWithExceptions([{ review_status: 'rejected' }]), false);
  assert.equal(canApproveWithExceptions(Array.from({ length: 9 }, () => ({ review_status: 'approved' }))), false);
  assert.equal(canApproveWithExceptions(null), false);
});

test('only independently authorized coordinators review an exception, never its submitter', () => {
  assert.equal(canReviewException('tenant_admin', 'admin', 'operator'), true);
  assert.equal(canReviewException('agronomic_coordinator', 'coord', 'operator'), true);
  assert.equal(canReviewException('tenant_admin', 'operator', 'operator'), false);
  assert.equal(canReviewException('contractor', 'other', 'operator'), false);
  assert.equal(canReviewException('scout', 'other', 'operator'), false);
});

test('response metadata excludes tenant ID and client idempotency UUID', () => {
  const publicView = publicException({ ...existing, id: 'xx', tenant_id: 'SECRET_TENANT',
    client_request_id: 'SECRET_RETRY', created_at: '2026-10-16',
    reviewed_by: null, reviewed_at: null, review_note: null,
    input_name: 'Insumo demo', unit: 'L' });
  assert.equal(publicView.input_name, 'Insumo demo');
  assert.equal(publicView.quantity, '0.7500');
  assert.doesNotMatch(JSON.stringify(publicView), /SECRET_TENANT|SECRET_RETRY/);
});
