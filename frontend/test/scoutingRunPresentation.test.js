import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseScoutingRuns, parseScoutingRunDetail, isFocusedScoutingRunUnavailable,
  scoutingRunCapabilities, scoutingPrivateViewScope, visibleScoutingRuns
} from '../src/services/scoutingRunPresentation.js';

const ID = 'run-1';
const run = (status = 'planned') => ({
  id: ID, status, assigned_to: 'scout-1',
  ScoutingObservations: [{ id: 'obs-1', EvidenceAssets: [] }]
});
const session = (roleCode, userId = 'scout-1') => ({
  authenticated: true, user: { id: userId }, tenant: { id: 'tenant-A' },
  membership: { roleCode }
});

test('live scouting list rejects failed or malformed responses instead of showing an empty list', () => {
  assert.deepEqual(parseScoutingRuns({ data: [] }), []);
  assert.equal(parseScoutingRuns({ data: [run()] })[0].id, ID);
  for (const payload of [undefined, {}, { data: null }, { data: {} },
    { data: [{ id: ID }] }, { data: [{ id: '', status: 'planned' }] },
    { data: [{ id: ID, status: 'unknown' }] }]) {
    assert.throws(() => parseScoutingRuns(payload), /lista de recorridas inválida/);
  }
});

test('detail refuses a different run, partial observations or missing evidence collection', () => {
  assert.equal(parseScoutingRunDetail({ data: run() }, ID).id, ID);
  for (const response of [
    null, {}, { data: [] }, { data: run('unknown') },
    { data: { ...run(), id: 'another' } },
    { data: { ...run(), ScoutingObservations: null } },
    { data: { ...run(), ScoutingObservations: [{ id: 'obs-1' }] } }
  ]) {
    assert.throws(() => parseScoutingRunDetail(response, ID), /detalle de recorrida inválido/);
  }
});

test('focused deep link only reports unavailable after a successful scoped collection', () => {
  const rows = [run()];
  assert.equal(isFocusedScoutingRunUnavailable('other', rows, false, ''), true);
  assert.equal(isFocusedScoutingRunUnavailable(ID, rows, false, ''), false);
  assert.equal(isFocusedScoutingRunUnavailable('other', rows, true, ''), false);
  assert.equal(isFocusedScoutingRunUnavailable('other', rows, false, 'API 503'), false);
  assert.equal(isFocusedScoutingRunUnavailable(null, rows, false, ''), false);
});

test('scout may operate own run but never a reassigned one', () => {
  assert.deepEqual(scoutingRunCapabilities(run(), session('scout'), 'live'),
    { canManage: false, canOperate: true, canObserve: true });
  assert.deepEqual(scoutingRunCapabilities(run(), session('scout', 'other'), 'live'),
    { canManage: false, canOperate: false, canObserve: false });
  assert.equal(scoutingRunCapabilities(run('completed'), session('scout'), 'live').canObserve, false);
});

test('admins and coordinators can manage; outsiders, expired sessions and demo cannot', () => {
  for (const role of ['tenant_admin', 'agronomic_coordinator']) {
    assert.deepEqual(scoutingRunCapabilities(run(), session(role), 'live'),
      { canManage: true, canOperate: true, canObserve: true });
  }
  for (const role of ['contractor', 'producer_viewer', 'platform_admin', 'constructor']) {
    assert.equal(scoutingRunCapabilities(run(), session(role), 'live').canOperate, false);
  }
  assert.equal(scoutingRunCapabilities(run(), session('tenant_admin'), 'mock').canManage, false);
  assert.equal(scoutingRunCapabilities(null, session('tenant_admin'), 'live').canManage, false);
  assert.equal(scoutingRunCapabilities(run(), { ...session('scout'), authenticated: false }, 'live').canObserve, false);
});

test('scouting list scope fences tenant, actor, membership, role and entitlements', () => {
  const initial = { ...session('scout'),
    membership: { id: 'member-1', roleCode: 'scout' },
    entitlements: ['scouting', 'gis'] };
  const scope = scoutingPrivateViewScope(initial, 'live');
  assert.ok(scope);
  assert.equal(scoutingPrivateViewScope({ ...initial,
    entitlements: ['gis', 'scouting', 'gis'] }, 'live'), scope);
  for (const patch of [
    { tenant: { id: 'tenant-B' } }, { user: { id: 'other' } },
    { membership: { id: 'member-2', roleCode: 'scout' } },
    { membership: { id: 'member-1', roleCode: 'tenant_admin' } },
    { entitlements: ['scouting', 'reports'] }
  ]) assert.notEqual(scoutingPrivateViewScope({ ...initial, ...patch }, 'live'), scope);
  for (const patch of [
    { authenticated: false }, { user: {} }, { tenant: {} },
    { membership: null }, { membership: { roleCode: 'scout' } },
    { entitlements: ['gis'] }, { entitlements: null }
  ]) assert.equal(scoutingPrivateViewScope({ ...initial, ...patch }, 'live'), null);
  assert.equal(scoutingPrivateViewScope(initial, 'mock'), 'demo');
});

test('same tenant with another API transport never displays previous run GPS or lot names', () => {
  const api = {};
  const rows = [run()];
  const scope = 'authorized-scope';
  assert.equal(visibleScoutingRuns(rows, scope, api, scope, api), rows);
  assert.deepEqual(visibleScoutingRuns(rows, scope, api, scope, {}), []);
  assert.deepEqual(visibleScoutingRuns(rows, scope, api, 'other', api), []);
  assert.deepEqual(visibleScoutingRuns(rows, scope, api, null, api), []);
});

test('explicit foreign-tenant scouting lists and details are rejected', () => {
  const own = { ...run(), tenant_id: 'tenant-A' };
  assert.deepEqual(parseScoutingRuns({ data: [own] }, 'tenant-A'), [own]);
  assert.equal(parseScoutingRunDetail({ data: own }, ID, 'tenant-A'), own);
  assert.throws(() => parseScoutingRuns({
    data: [{ ...own, tenant_id: 'tenant-B' }]
  }, 'tenant-A'), /lista de recorridas inválida/);
  assert.throws(() => parseScoutingRunDetail({
    data: { ...own, tenant_id: 'tenant-B' }
  }, ID, 'tenant-A'), /detalle de recorrida inválido/);
});

test('scouting component remounts details after membership or API change before showing old names', () => {
  const source = readFileSync(new URL('../src/pages/ScoutingPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /scoutingPrivateViewScope\(session, dataMode\)/);
  assert.match(source, /setLoadedApi\(api\)/);
  assert.match(source, /visibleScoutingRuns\(runs, loadedScope, loadedApi, scope, api\)/);
  assert.match(source, /listApiRef\.current === api/);
  assert.match(source, /parseScoutingRuns\(response, session\.tenant\.id\)/);
  assert.match(source, /parseScoutingRunDetail\(response, run\.id, session\?\.tenant\?\.id\)/);
  assert.match(source, /<RunDetail key=\{scope \+ ':' \+ run\.id\}/);
  assert.match(source, /\{showModal && canPlan && <ScoutingRunFormModal/);
});
