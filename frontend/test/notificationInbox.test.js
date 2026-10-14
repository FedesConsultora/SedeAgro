import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationScope, parseNotificationList, parseReadReceipt,
  unreadNotifications, notificationDestination
} from '../src/services/notificationInbox.js';

const ID = '199462fd-8f81-4cbe-8e79-e098a5dba830';
const RUN = '7a1c71a5-4c14-4784-87d0-b324d92e7eaa';
const session = { authenticated: true, user: { id: 'user-A' },
  tenant: { id: 'tenant-A' } };
const note = (overrides = {}) => ({
  id: ID, tenant_id: 'tenant-A', user_id: 'user-A',
  type: 'assignment', title: 'Nueva recorrida',
  body: 'Tenés una tarea asignada',
  entity_type: 'scouting_run', entity_id: RUN,
  created_at: '2026-10-14T11:15:00Z', read_at: null, ...overrides
});
const access = (role, entitlements) => ({ role, entitlements, platformAdmin: false });

test('inbox is available only with a real authenticated user and tenant', () => {
  assert.equal(notificationScope(session, 'live'), 'tenant-A:user-A');
  for (const scope of [
    notificationScope(session, 'mock'),
    notificationScope({ ...session, authenticated: false }, 'live'),
    notificationScope({ ...session, user: {} }, 'live'),
    notificationScope({ ...session, tenant: {} }, 'live')
  ]) assert.equal(scope, null);
});

test('valid notifications and unread count follow actual server fields', () => {
  const items = parseNotificationList({ data: [
    note(), note({ id: RUN, read_at: '2026-10-14T12:00:00Z' })
  ] }, session);
  assert.equal(items.length, 2);
  assert.equal(unreadNotifications(items), 1);
  assert.equal(unreadNotifications([items[1]]), 0);
});

test('malformed, duplicate, cross-user and cross-tenant responses fail closed', () => {
  for (const payload of [
    null, {}, { data: null }, { data: {} },
    { data: [note({ user_id: 'user-B' })] },
    { data: [note({ tenant_id: 'tenant-B' })] },
    { data: [note({ id: 'not-a-uuid' })] },
    { data: [note({ title: '' })] },
    { data: [note({ read_at: 'invalid' })] },
    { data: [note(), note()] },
    { data: Array.from({ length: 51 }, (_, index) => note({ id: String(index) })) }
  ]) assert.throws(() => parseNotificationList(payload, session), /No se pudo verificar/);
});

test('mark read requires receipt for same ID, user and tenant, never an optimistic guess', () => {
  const before = note();
  const read = note({ read_at: '2026-10-14T12:00:00Z' });
  assert.deepEqual(parseReadReceipt({ data: read }, before, session), read);
  for (const response of [
    {}, { data: before }, { data: note({ id: RUN, read_at: read.read_at }) },
    { data: note({ tenant_id: 'tenant-B', read_at: read.read_at }) },
    { data: note({ user_id: 'user-B', read_at: read.read_at }) }
  ]) assert.throws(() => parseReadReceipt(response, before, session), /no confirmó/);
});

test('navigation to a notification is whitelisted and access-controlled', () => {
  assert.deepEqual(notificationDestination(note(), access('scout', ['scouting'])),
    { view: 'scouting', id: RUN });
  assert.deepEqual(notificationDestination(note({ entity_type: 'work_order' }),
    access('contractor', ['work_orders'])), { view: 'orders', id: RUN });
  for (const candidate of [
    notificationDestination(note(), access('contractor', ['scouting'])),
    notificationDestination(note(), access('scout', [])),
    notificationDestination(note({ entity_type: 'work_order' }), access('scout', ['work_orders'])),
    notificationDestination(note({ entity_type: 'external_link' }), access('tenant_admin', ['scouting'])),
    notificationDestination(note({ entity_id: '../admin' }), access('tenant_admin', ['scouting'])),
    notificationDestination(note({ entity_type: 'field' }), access('tenant_admin', ['gis']))
  ]) assert.equal(candidate, null);
});
