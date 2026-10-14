import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_RECIPIENT_ROLES, assignmentNotice, shouldNotifyRunAssignment
} from '../src/modules/notifications/assignmentNotificationPolicy.js';

const tenantId = '74e425ed-9ad4-4aa7-b173-2fa30b0d2b6d';
const userId = 'e1840fc2-b77a-4872-b9d1-fc507290090e';
const entityId = 'af39c90f-49b9-4c0b-84e3-dc8ca66f1a85';

test('run notifications only target a real new assignee, never no-op or unassign', () => {
  assert.equal(shouldNotifyRunAssignment(null, userId), true);
  assert.equal(shouldNotifyRunAssignment(tenantId, userId), true);
  assert.equal(shouldNotifyRunAssignment(userId, userId), false);
  assert.equal(shouldNotifyRunAssignment(userId, null), false);
  assert.equal(shouldNotifyRunAssignment(null, 'not-a-uuid'), false);
});

test('notification payload has fixed, non-sensitive wording and authorized navigation entity', () => {
  for (const entityType of ['scouting_run', 'work_order']) {
    const note = assignmentNotice({ tenantId, userId, entityType, entityId });
    assert.deepEqual(Object.keys(note).sort(), [
      'tenant_id', 'user_id', 'type', 'title', 'body', 'entity_type', 'entity_id'
    ].sort());
    assert.equal(note.tenant_id, tenantId);
    assert.equal(note.user_id, userId);
    assert.equal(note.entity_id, entityId);
    assert.equal(note.entity_type, entityType);
    assert.equal(note.type, 'assignment');
    assert.match(note.title, /asignada/);
    assert.doesNotMatch(JSON.stringify(note), /órdenes confidenciales|instrucciones de campo/);
  }
});

test('fail closed on unsupported entity and malformed tenant, user or entity IDs', () => {
  const valid = { tenantId, userId, entityType: 'work_order', entityId };
  for (const bad of [
    { entityType: 'field' }, { entityType: 'https://example.org' },
    { tenantId: 'tenantA' }, { userId: null }, { entityId: undefined },
    { entityId: '../admin' }, { entityId: tenantId.replace(/-/g, '') }
  ]) assert.throws(() => assignmentNotice({ ...valid, ...bad }), /IDs verificados/);
});

test('orders only notify roles allowed to open the orders module', () => {
  assert.deepEqual(ORDER_RECIPIENT_ROLES,
    ['tenant_admin', 'agronomic_coordinator', 'contractor']);
  for (const rejected of ['scout', 'producer_viewer', 'platform_admin']) {
    assert.equal(ORDER_RECIPIENT_ROLES.includes(rejected), false);
  }
});
