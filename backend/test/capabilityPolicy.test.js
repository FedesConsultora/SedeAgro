import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCapability, requireCapability } from '../src/infra/http/middlewares/requireCapability.js';
import { canTransitionWorkOrder, WORK_ORDER_TRANSITIONS } from '../src/modules/workOrders/workOrderPolicy.js';

const TENANT = 'tenant-A';
function principal(roleCode, tenantId = TENANT) {
  return {
    user: { id: 'user-1' },
    role: { code: roleCode },
    membership: {
      user_id: 'user-1', tenant_id: tenantId, role_code: roleCode, status: 'active'
    }
  };
}

test('RBAC grants tenant admin and coordinator but no implicit platform privileges', () => {
  assert.equal(hasCapability(principal('tenant_admin'), TENANT, 'orders.write'), true);
  assert.equal(hasCapability(principal('agronomic_coordinator'), TENANT, 'orders.execute'), true);
  assert.equal(hasCapability(principal('platform_admin'), TENANT, 'orders.write'), false);
  assert.equal(hasCapability(principal('unknown'), TENANT, 'orders.read'), false);
  assert.equal(hasCapability(principal('constructor'), TENANT, 'orders.read'), false);
});

test('scouts may observe, but cannot approve orders or change fields', () => {
  assert.equal(hasCapability(principal('scout'), TENANT, 'scouting.observe'), true);
  assert.equal(hasCapability(principal('scout'), TENANT, 'scouting.plan'), false);
  assert.equal(hasCapability(principal('scout'), TENANT, 'orders.execute'), false);
  assert.equal(hasCapability(principal('scout'), TENANT, 'gis.write'), false);
});

test('contractors have only scoped order permissions; unscoped producers cannot read tenant data', () => {
  assert.equal(hasCapability(principal('contractor'), TENANT, 'orders.read'), true);
  assert.equal(hasCapability(principal('contractor'), TENANT, 'orders.write'), false);
  assert.equal(hasCapability(principal('producer_viewer'), TENANT, 'reports.read'), false);
});

test('tenant mismatch, role tampering and inactive membership are denied', () => {
  assert.equal(hasCapability(null, TENANT, 'gis.read'), false);
  assert.equal(hasCapability(principal('tenant_admin', 'tenant-B'), TENANT, 'gis.read'), false);
  const p = principal('tenant_admin'); p.role.code = 'scout';
  assert.equal(hasCapability(p, TENANT, 'gis.read'), false);
  const blocked = principal('tenant_admin'); blocked.membership.status = 'blocked';
  assert.equal(hasCapability(blocked, TENANT, 'gis.read'), false);
  const wrongActor = principal('tenant_admin'); wrongActor.membership.user_id = 'user-2';
  assert.equal(hasCapability(wrongActor, TENANT, 'gis.read'), false);
});

test('authorization middleware fails closed and reports 403', () => {
  let error;
  requireCapability('teams.write')({ auth: principal('scout'), tenantId: TENANT }, {}, (nextError) => { error = nextError; });
  assert.equal(error.status, 403);
  assert.equal(error.code, 'CAPABILITY_DENIED');
  error = 'not called';
  requireCapability('scouting.observe')({ auth: principal('scout'), tenantId: TENANT }, {}, (nextError) => { error = nextError; });
  assert.equal(error, undefined);
});

test('work-order workflow refuses skipped, repeated, and terminal transitions', () => {
  assert.equal(canTransitionWorkOrder('draft', 'approved', 'tenant_admin'), false);
  assert.equal(canTransitionWorkOrder('draft', 'completed', 'tenant_admin'), false);
  assert.equal(canTransitionWorkOrder('assigned', 'assigned', 'tenant_admin'), false);
  assert.equal(canTransitionWorkOrder('completed', 'in_progress', 'tenant_admin'), false);
  assert.equal(canTransitionWorkOrder('constructor', 'assigned', 'tenant_admin'), false);
  assert.equal(canTransitionWorkOrder('draft', 'pending_approval', 'tenant_admin'), true);
  assert.equal(canTransitionWorkOrder('pending_approval', 'approved', 'agronomic_coordinator'), true);
  assert.equal(canTransitionWorkOrder('approved', 'assigned', 'tenant_admin'), true);
  assert.equal(canTransitionWorkOrder('in_progress', 'completed', 'agronomic_coordinator'), true);
  assert.deepEqual(WORK_ORDER_TRANSITIONS.cancelled, []);
});

test('contractor may only advance assigned orders during execution', () => {
  assert.equal(canTransitionWorkOrder('assigned', 'in_progress', 'contractor', true), true);
  assert.equal(canTransitionWorkOrder('in_progress', 'completed', 'contractor', true), true);
  assert.equal(canTransitionWorkOrder('assigned', 'in_progress', 'contractor', false), false);
  assert.equal(canTransitionWorkOrder('pending_approval', 'approved', 'contractor', true), false);
  assert.equal(canTransitionWorkOrder('in_progress', 'cancelled', 'contractor', true), false);
});
