import test from 'node:test';
import assert from 'node:assert/strict';
import { availableWorkOrderTransitions, validateWorkOrderDetail } from '../src/services/workOrderDetails.js';

const ID = 'order-1';
const order = (status, assignees = []) =>
  ({ id: ID, status, WorkOrderAssignees: assignees });
const assigned = [{ user_id: 'contractor-1' }];

test('detail requires the requested record and a complete assignee collection', () => {
  assert.deepEqual(validateWorkOrderDetail({ data: order('assigned', assigned) }, ID), order('assigned', assigned));
  for (const response of [null, {}, { data: [] }, { data: { id: ID, status: 'assigned' } },
    { data: { id: ID, status: 'other', WorkOrderAssignees: [] } },
    { data: { ...order('completed', []), id: 'different-order' } }]) {
    assert.throws(() => validateWorkOrderDetail(response, ID), /detalle de orden inválido/i);
  }
});

test('administrators and coordinators only see legal transitions', () => {
  assert.deepEqual(availableWorkOrderTransitions(order('draft'), 'tenant_admin', 'admin', true), ['pending_approval', 'cancelled']);
  assert.deepEqual(availableWorkOrderTransitions(order('pending_approval'), 'agronomic_coordinator', 'admin', true),
    ['approved', 'draft', 'cancelled']);
  assert.deepEqual(availableWorkOrderTransitions(order('approved', assigned), 'tenant_admin', 'admin', true),
    ['assigned', 'cancelled']);
  assert.deepEqual(availableWorkOrderTransitions(order('approved'), 'tenant_admin', 'admin', true), ['cancelled']);
  assert.deepEqual(availableWorkOrderTransitions(order('completed'), 'tenant_admin', 'admin', true), []);
});

test('contractors only advance assigned work on their own account', () => {
  assert.deepEqual(availableWorkOrderTransitions(order('assigned', assigned), 'contractor', 'contractor-1', true),
    ['in_progress']);
  assert.deepEqual(availableWorkOrderTransitions(order('in_progress', assigned), 'contractor', 'contractor-1', true),
    ['completed']);
  assert.deepEqual(availableWorkOrderTransitions(order('pending_approval', assigned), 'contractor', 'contractor-1', true), []);
  assert.deepEqual(availableWorkOrderTransitions(order('assigned', assigned), 'contractor', 'other-user', true), []);
  assert.deepEqual(availableWorkOrderTransitions(order('assigned'), 'contractor', 'contractor-1', true), []);
});

test('non-operators, demo mode and missing identities cannot mutate work orders', () => {
  for (const role of ['scout', 'producer_viewer', 'platform_admin', 'constructor', null]) {
    assert.deepEqual(availableWorkOrderTransitions(order('draft'), role, 'actor', true), []);
  }
  assert.deepEqual(availableWorkOrderTransitions(order('draft'), 'tenant_admin', 'admin'), []);
  assert.deepEqual(availableWorkOrderTransitions(order('assigned', assigned), 'contractor', '', true), []);
  assert.deepEqual(availableWorkOrderTransitions(order('unknown'), 'tenant_admin', 'admin', true), []);
});
