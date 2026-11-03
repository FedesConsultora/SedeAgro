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
    []);
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

test('server-verified order provenance must contain exact UUIDs and never authorize itself', () => {
  const id='9d941d8a-9a66-4c6d-8469-54c37596e3a9';
  const origin={
    scouting_observation_id:'b6a4534c-6e82-4f4e-b0a2-35b6d4f9317d',
    scouting_run_id:'ce2405b5-2d3e-48b0-905f-b294e90df64f'
  };
  const detailed={...order('draft'),observation_origin:origin};
  assert.deepEqual(validateWorkOrderDetail({data:detailed},ID),detailed);
  for(const wrong of [[],{},{
    ...origin,scouting_run_id:'bad'
  },{
    ...origin,scouting_observation_id:'wrong'
  }]) assert.throws(()=>validateWorkOrderDetail({data:{
    ...detailed,observation_origin:wrong
  }},ID),/detalle de orden inválido/i);
});
