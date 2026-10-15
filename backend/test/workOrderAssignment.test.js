import test from 'node:test';
import assert from 'node:assert/strict';
import { canAddWorkOrderAssignee, hasActiveWorkOrderExecutor, safeAuditRequestId } from '../src/modules/workOrders/assignmentPolicy.js';

test('operational assignments freeze as soon as the order becomes assigned', () => {
  for (const status of ['draft', 'pending_approval', 'approved']) {
    assert.equal(canAddWorkOrderAssignee(status), true, status);
  }
  for (const status of ['assigned', 'in_progress', 'completed', 'cancelled', null, 'unknown']) {
    assert.equal(canAddWorkOrderAssignee(status), false, String(status));
  }
});

test('an assignment cannot advance with only revoked or ineligible executors', () => {
  assert.equal(hasActiveWorkOrderExecutor([], []), false);
  assert.equal(hasActiveWorkOrderExecutor(['suspended'], []), false);
  assert.equal(hasActiveWorkOrderExecutor(['suspended'], ['another-user']), false);
  assert.equal(hasActiveWorkOrderExecutor(['suspended', 'current'], ['current']), true);
  assert.equal(hasActiveWorkOrderExecutor(['revoked', 'active'], ['active', 'other']), true);
});

test('work order routing keeps authorization, locks and tenant-scoped audit writes', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/modules/workOrders/router.js', import.meta.url), 'utf8');
  assert.match(source, /workOrdersRouter\.post\('\/:id\/assignees', requireCapability\('orders\.write'\)/);
  assert.match(source, /workOrdersRouter\.patch\('\/:id\/status', requireCapability\('orders\.execute'\)/);
  assert.match(source, /lock: req\.dbTransaction\.LOCK\.UPDATE/g);
  assert.match(source, /hasActiveWorkOrderExecutor\(userIds, memberships\.map/);
  assert.match(source, /canAddWorkOrderAssignee\(order\.status\)/);
  assert.match(source, /action: 'work_order\.assignee_added'/);
  assert.match(source, /action: 'work_order\.status_changed'/);
  assert.match(source, /tenant_id: req\.tenantId/);
  assert.match(source, /transaction: req\.dbTransaction/);
});

test('audit does not accept malformed caller-controlled request IDs', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(safeAuditRequestId(id), id);
  for (const raw of ['request-from-browser', '../../tenant', '', null, 42]) {
    assert.equal(safeAuditRequestId(raw), null);
  }
});
