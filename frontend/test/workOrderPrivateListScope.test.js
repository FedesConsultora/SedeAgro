import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  workOrderPrivateListScope, checkedWorkOrderPrivateRows,
  visibleWorkOrderPrivateSnapshot, visibleWorkOrderPrivateSelection
} from '../src/services/workOrderPrivateListScope.js';

const tenant = 'f9dfc026-f4e7-45d7-9cb2-f14fe21104ac';
const other = 'ba94f2ce-dc48-4efe-bc03-47f7c17d7d53';
const user = 'a342ab24-3245-4be8-9cb5-36acc36a7afe';
const membership = 'ac69fb90-bfa7-4bd2-a0a5-d40767fb4cc1';
const session = {
  authenticated: true,
  tenant: { id: tenant }, user: { id: user },
  membership: { id: membership, roleCode: 'tenant_admin' },
  entitlements: ['work_orders', 'org']
};

test('scope changes with tenant, actor, membership, role and capability, never with order of entitlements', () => {
  const scope = workOrderPrivateListScope(session, 'live');
  assert.ok(scope);
  assert.equal(workOrderPrivateListScope({
    ...session, entitlements: ['org', 'work_orders', 'org']
  }, 'live'), scope);
  for (const patch of [
    { tenant: { id: other } }, { user: { id: other } },
    { membership: { id: other, roleCode: 'tenant_admin' } },
    { membership: { id: membership, roleCode: 'contractor' } },
    { entitlements: ['work_orders', 'scouting'] }
  ]) assert.notEqual(workOrderPrivateListScope({ ...session, ...patch }, 'live'), scope);
  for (const patch of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: null }, { entitlements: ['org'] }, { entitlements: null }
  ]) assert.equal(workOrderPrivateListScope({ ...session, ...patch }, 'live'), null);
  assert.equal(workOrderPrivateListScope(session, 'mock'), 'demo');
  assert.equal(workOrderPrivateListScope(session, 'offline'), null);
});

test('mismatched or malformed backend order lists fail closed', () => {
  const rows = [{ id: 'order-1', tenant_id: tenant, title: 'Aplicación' }];
  assert.equal(checkedWorkOrderPrivateRows(rows, tenant), rows);
  assert.deepEqual(checkedWorkOrderPrivateRows([{ id: 'old-order' }], tenant),
    [{ id: 'old-order' }]);
  for (const invalid of [undefined, null, {}, [{ id: 'a', tenant_id: other }],
    [null], [[]], [{ id: 10 }], [{ id: '' }]]) {
    assert.throws(() => checkedWorkOrderPrivateRows(invalid, tenant), /inválidas|otra empresa/);
  }
  assert.throws(() => checkedWorkOrderPrivateRows([], null), /inválidas/);
});

test('old actor, changed API and refresh hide private list and selected detail synchronously', () => {
  const scope = workOrderPrivateListScope(session, 'live');
  const api = {};
  const order = { id: 'order-1', title: 'Confidencial' };
  const snapshot = { scope, api, revision: 2, rows: [order], phase: 'ready' };
  const selection = { scope, api, revision: 2, order };
  assert.equal(visibleWorkOrderPrivateSnapshot(snapshot, scope, api, 2), snapshot);
  assert.equal(visibleWorkOrderPrivateSelection(selection, scope, api, 2), order);
  for (const [newScope, newApi, revision] of [
    [null, api, 2], ['demo', api, 2], [scope, {}, 2], [scope, api, 3]
  ]) {
    assert.equal(visibleWorkOrderPrivateSnapshot(snapshot, newScope, newApi, revision), null);
    assert.equal(visibleWorkOrderPrivateSelection(selection, newScope, newApi, revision), null);
  }
});

test('WorkOrdersPage binds rendered list, review inbox, focus and detail to the exact scope', () => {
  const source = readFileSync(new URL('../src/pages/WorkOrdersPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /workOrderPrivateListScope\(session, dataMode\)/);
  assert.match(source, /visibleWorkOrderPrivateSnapshot\(snapshot, scope, api, revision\)/);
  assert.match(source, /visibleWorkOrderPrivateSelection\(selectedSnapshot, scope, api, revision\)/);
  assert.match(source, /checkedWorkOrderPrivateRows\(response\.data, session\.tenant\.id\)/);
  assert.match(source, /scopeRef\.current === scope && apiRef\.current === api/);
  assert.match(source, /<WorkOrderReviewInbox key=\{scope\}/);
  assert.match(source, /selectedOrder && <WorkOrderDetailDrawer key=\{/);
  assert.doesNotMatch(source, /setOrders\(/);
  assert.doesNotMatch(source, /setSelectedOrder\(/);
});
