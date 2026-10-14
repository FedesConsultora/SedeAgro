import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScoutingRuns, parseScoutingRunDetail, isFocusedScoutingRunUnavailable,
  scoutingRunCapabilities
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
