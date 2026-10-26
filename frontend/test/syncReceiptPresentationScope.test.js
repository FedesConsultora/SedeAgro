import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  syncReceiptPresentationScope, visibleSyncReceiptRows, checkedSyncReceiptRows
} from '../src/services/syncReceiptPresentationScope.js';

const tenant = '731855a9-0975-410c-8aee-191557b22d08';
const other = '14e1e7be-af3a-49ae-ae15-7c8ff31d28e2';
const actor = '827bfacc-2026-41b9-9ed1-13d74b2f7fbc';
const membership = 'f8ca0f84-5a2c-4b07-bc6f-8edb12cd2c5e';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: membership, roleCode: 'tenant_admin' },
  entitlements: ['scouting', 'reports'] };

test('receipt scope is actor, membership, role, tenant and capability specific', () => {
  const scope = syncReceiptPresentationScope(session, 'live');
  assert.ok(scope);
  assert.equal(syncReceiptPresentationScope({
    ...session, entitlements: ['reports', 'scouting', 'scouting']
  }, 'live'), scope);
  for (const patch of [
    { tenant: { id: other } }, { user: { id: other } },
    { membership: { id: other, roleCode: 'tenant_admin' } },
    { membership: { id: membership, roleCode: 'scout' } },
    { entitlements: ['scouting'] }
  ]) assert.notEqual(syncReceiptPresentationScope({ ...session, ...patch }, 'live'), scope);
  for (const patch of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: null }, { entitlements: null }, { entitlements: ['reports'] }
  ]) assert.equal(syncReceiptPresentationScope({ ...session, ...patch }, 'live'), null);
  assert.equal(syncReceiptPresentationScope(session, 'mock'), 'demo');
});

test('changed API or scope renders no prior receipt, even before effects run', () => {
  const api = {};
  const rows = [{ id: 'r-1', tenant_id: tenant }];
  const scope = syncReceiptPresentationScope(session, 'live');
  assert.equal(visibleSyncReceiptRows(rows, scope, api, scope, api), rows);
  assert.deepEqual(visibleSyncReceiptRows(rows, scope, api, scope, {}), []);
  assert.deepEqual(visibleSyncReceiptRows(rows, scope, api, 'demo', api), []);
  assert.deepEqual(visibleSyncReceiptRows(rows, scope, api, null, api), []);
  assert.deepEqual(visibleSyncReceiptRows(null, scope, api, scope, api), []);
});

test('explicit foreign tenant or malformed receipts rejected before display', () => {
  const rows = [{ id: 'r-1', tenant_id: tenant }, { id: 'r-2' }];
  assert.equal(checkedSyncReceiptRows(rows, tenant), rows);
  for (const bad of [null, {}, [null], [[]], [{ id: 3 }],
    [{ id: '' }], [{ id: 'r-3', tenant_id: other }]]) {
    assert.throws(() => checkedSyncReceiptRows(bad, tenant), /inválidos|otra empresa/);
  }
});

test('SyncPage binds receipt rendering and async responses to the API transport', () => {
  const source = readFileSync(new URL('../src/pages/SyncPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /syncReceiptPresentationScope\(session, dataMode\)/);
  assert.match(source, /setLoadedServerApi\(api\)/);
  assert.match(source, /serverApiRef\.current === api/);
  assert.match(source, /checkedSyncReceiptRows\(response\.data, session\.tenant\.id\)/);
  assert.match(source, /visibleSyncReceiptRows\(batches, loadedServerScope, loadedServerApi, serverScope, api\)/);
  assert.match(source, /loadedServerApi !== api/);
});
