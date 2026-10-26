import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkedTenantCollectionRows, visibleTenantCollectionState } from
  '../src/services/tenantCollectionRenderSafety.js';

test('same tenant with another API, or same API after refresh, hides old snapshot before effect', () => {
  const apiA = {};
  const apiB = {};
  const snapshot = { scope: 'tenant-A', api: apiA, revision: 4,
    status: 'ready', records: [{ name: 'Campo privado' }] };
  assert.equal(visibleTenantCollectionState(snapshot, 'tenant-A', apiA, 4), snapshot);
  for (const [scope, api, revision] of [
    ['tenant-B', apiA, 4], ['tenant-A', apiB, 4], ['tenant-A', apiA, 5],
    [null, apiA, 4], ['demo', apiA, 4]
  ]) assert.equal(visibleTenantCollectionState(snapshot, scope, api, revision), null);
});

test('explicit foreign tenant rows and malformed records fail closed', () => {
  const own = [{ id: 'farm-1', tenant_id: 'tenant-A' }, { id: 'farm-2' }];
  assert.equal(checkedTenantCollectionRows(own, 'tenant-A', 'establecimientos'), own);
  for (const rows of [
    null, {}, [null], [[]], [{ id: 'farm-3', tenant_id: 'tenant-B' }]
  ]) assert.throws(() =>
    checkedTenantCollectionRows(rows, 'tenant-A', 'establecimientos'),
    /inválidos|otra empresa/);
  assert.throws(() => checkedTenantCollectionRows([], null), /inválidos/);
  assert.deepEqual(checkedTenantCollectionRows([], 'tenant-A'), []);
});

test('hook never renders an out-of-date tenant, API transport or revision', () => {
  const source = readFileSync(new URL('../src/services/useTenantCollection.js', import.meta.url), 'utf8');
  assert.match(source, /visibleTenantCollectionState\(state, scope, api, revision\)/);
  assert.match(source, /checkedTenantCollectionRows\(extractCollection\(response, title\), scope, title\)/);
  assert.match(source, /if \(current\(\)\) setState/);
  assert.match(source, /\[api, method, dataMode, scope, mockRecords, title, revision\]/);
  assert.match(source, /if \(!visible\) return \{ records: \[\], loading: Boolean\(scope\), error:/);
  assert.doesNotMatch(source, /if \(state\.scope !== scope\)/);
});
