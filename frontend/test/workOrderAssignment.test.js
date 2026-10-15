import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canManageWorkOrderAssignments, eligibleWorkOrderMembers,
  validateWorkOrderAssignmentResponse
} from '../src/services/workOrderAssignment.js';

const member = (id, role = 'contractor', status = 'active', userStatus = 'active') => ({
  user_id: id, role_code: role, status,
  User: { full_name: 'Persona ' + id, status: userStatus }
});

test('assignment UI is restricted to coordinators and administrators in live planning states', () => {
  for (const status of ['draft', 'pending_approval', 'approved']) {
    for (const role of ['tenant_admin', 'agronomic_coordinator']) {
      assert.equal(canManageWorkOrderAssignments({ status }, role, true), true);
    }
    for (const role of ['contractor', 'producer_viewer', 'scout', null]) {
      assert.equal(canManageWorkOrderAssignments({ status }, role, true), false);
    }
  }
  for (const status of ['assigned', 'in_progress', 'completed', 'cancelled']) {
    assert.equal(canManageWorkOrderAssignments({ status }, 'tenant_admin', true), false);
  }
  assert.equal(canManageWorkOrderAssignments({ status: 'draft' }, 'tenant_admin', false), false);
});

test('only active tenant directory records with suitable roles are selectable', () => {
  const response = { data: [
    member('already'), member('free'), member('revoked', 'contractor', 'blocked'),
    member('disabled', 'contractor', 'active', 'blocked'),
    member('scout', 'scout'), member('coordinator', 'agronomic_coordinator'),
    member('admin', 'tenant_admin')
  ] };
  const selected = eligibleWorkOrderMembers(response, [{ user_id: 'already' }]);
  assert.deepEqual(selected.map(x => x.id).sort(), ['admin', 'coordinator', 'free']);
  assert.throws(() => eligibleWorkOrderMembers({ data: null }), /directorio válido/);
  assert.throws(() => eligibleWorkOrderMembers({}), /directorio válido/);
});

test('a claimed assignment is not treated as success without matching server confirmation', () => {
  const response = { data: { id: 'record', user_id: 'target', work_order_id: 'order' } };
  assert.deepEqual(validateWorkOrderAssignmentResponse(response, 'order', 'target'), response.data);
  for (const invalid of [{}, { data: { ...response.data, work_order_id: 'foreign' } },
    { data: { ...response.data, user_id: 'foreign' } }, { data: { user_id: 'target', work_order_id: 'order' } }]) {
    assert.throws(() => validateWorkOrderAssignmentResponse(invalid, 'order', 'target'), /no confirmó/);
  }
});

test('live drawer uses the real members endpoint and a server-side assignment write', () => {
  const picker = readFileSync(new URL('../src/components/WorkOrderAssigneePicker.jsx', import.meta.url), 'utf8');
  const drawer = readFileSync(new URL('../src/components/WorkOrderDetailDrawer.jsx', import.meta.url), 'utf8');
  assert.match(picker, /api\.members\(\)/);
  assert.match(picker, /api\.request\(\`\/work-orders\/\$\{encodeURIComponent\(order\.id\)\}\/assignees\`/);
  assert.match(picker, /method: 'POST'/);
  assert.match(picker, /validateWorkOrderAssignmentResponse\(response, order\.id, userId\)/);
  assert.match(picker, /onAssigned\?\.\(\)/);
  assert.match(drawer, /<WorkOrderAssigneePicker order=\{detail\} onAssigned=\{refresh\} \/>/);
});
