import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunPersonalSyncHistory, RUN_SYNC_HISTORY_PAGE_SIZE
} from '../src/services/runPersonalSyncHistory.js';

const TENANT = '9afff201-7572-4f63-a6fa-bcbdaaa015e5';
const USER = '8d127cb3-5604-4a5b-8a52-c748ce3e653a';
const OTHER = 'd3866ab6-10c8-41cd-ab3b-e092686721f8';
const RUN = '7800ac9c-2ff7-4b26-8789-4cefa61f4377';
const RUN2 = '26859f6f-dc33-4c80-8b69-c5a81f509a66';
const OBS = 'e80b4806-8985-4ac7-9f8e-9dd56ca9b701';
const OP = '76fb99e2-4e53-4a39-a0b5-f1a0e6ff7acc';
const BATCH = 'cb1e59f2-af11-4c14-9ddf-42a17acd981f';
const KEY = '8250e488-54e6-43f3-8eec-a0444e31ccba';
const session = (actor = USER, tenant = TENANT) => ({
  authenticated: true, user: { id: actor }, tenant: { id: tenant }
});
function operation(runId = RUN, overrides = {}) {
  return {
    id: OP, entity_type: 'scouting_observation', operation: 'create',
    entity_client_id: KEY, status: 'applied',
    result: { scouting_run_id: runId, observation_id: OBS },
    ...overrides
  };
}
function batch(ops = [operation()], overrides = {}) {
  return {
    id: BATCH, idempotency_key: KEY, client_id: 'sedeagro-web-offline-v1',
    submitted_by: USER, status: 'processed',
    received_at: '2026-10-14T10:00:00.000Z',
    processed_at: '2026-10-14T10:01:00.000Z',
    SyncOperations: ops, ...overrides
  };
}
const generateUuid = n => `cb1e59f2-af11-4c14-9ddf-${n.toString(16).padStart(12, '0')}`;

test('processed + applied + exact server run/observation identities certify one observation', () => {
  const model = buildRunPersonalSyncHistory({ data: [batch()] }, session(), RUN);
  assert.equal(model.confirmed, 1);
  assert.equal(model.unverified, 0);
  assert.equal(model.receiptWindow, 1);
  assert.equal(model.atLimit, false);
  assert.equal(model.entries[0].observationId, OBS);
  assert.equal(model.entries[0].batchId, BATCH);
  assert.equal(model.entries[0].status, 'confirmed');
  assert.equal(model.entries[0].timestamp, '2026-10-14T10:01:00.000Z');
  assert.equal(Object.hasOwn(model.entries[0], 'result'), false);
  assert.equal(RUN_SYNC_HISTORY_PAGE_SIZE, 10);
});

test('only operations whose SERVER result reports the requested run are attributable', () => {
  const rows = [batch([
    operation(RUN2),
    operation(RUN, { id: OTHER, entity_client_id: OTHER,
      result: { scouting_run_id: RUN, observation_id: OTHER } })
  ])];
  const model = buildRunPersonalSyncHistory({ data: rows }, session(), RUN);
  assert.equal(model.confirmed, 1);
  assert.equal(model.entries.length, 1);
  assert.equal(model.entries[0].observationId, OTHER);
  assert.equal(buildRunPersonalSyncHistory({ data: rows }, session(), RUN2).confirmed, 1);
  assert.equal(buildRunPersonalSyncHistory({ data: [] }, session(), RUN).entries.length, 0);
  assert.equal(buildRunPersonalSyncHistory({ data: [batch([
    operation(RUN2, { id: OTHER, entity_client_id: OTHER })])]}, session(), RUN).confirmed, 0);
});

test('batch processed state alone never authenticates a failed or incomplete operation', () => {
  const badOperations = [
    { status: 'failed' }, { operation: 'update' },
    { entity_type: 'work_order' }, { entity_client_id: 'not-uuid' },
    { id: 'not-uuid' }, { result: { scouting_run_id: RUN, observation_id: 'not-uuid' } }
  ];
  for (const change of badOperations) {
    const model = buildRunPersonalSyncHistory({ data: [batch([operation(RUN, change)])] }, session(), RUN);
    assert.equal(model.confirmed, 0);
    assert.equal(model.unverified, 1);
    assert.equal(model.entries[0].observationId, null);
  }
  for (const status of ['received', 'processing', 'failed']) {
    const model = buildRunPersonalSyncHistory({ data: [batch([operation()], { status })] }, session(), RUN);
    assert.equal(model.confirmed, 0);
    assert.equal(model.unverified, 1);
  }
});

test('no actor, tenant, receipt forgery or invalid run can be used as trusted history', () => {
  for (const response of [
    { data: [batch([operation()], { submitted_by: OTHER })] },
    { data: [batch([operation()], { id: 'not-an-id' })] },
    { data: [batch([operation()], { status: 'invented' })] },
    { data: {} }, { data: null }
  ]) assert.throws(() => buildRunPersonalSyncHistory(response, session(), RUN));
  assert.throws(() => buildRunPersonalSyncHistory({ data: [batch()] }, session(OTHER), RUN));
  assert.throws(() => buildRunPersonalSyncHistory({ data: [batch()] }, session(USER, OTHER), 'run!'));
  assert.throws(() => buildRunPersonalSyncHistory({ data: [batch()] }, session(), 'run!'));
  assert.throws(() => buildRunPersonalSyncHistory({ data: [batch(), batch()] }, session(), RUN),
    /duplicados/);
});

test('duplicate committed observation or operation identities are never double-counted', () => {
  const a = batch();
  const b = batch([operation(RUN, {
    id: OTHER, entity_client_id: OTHER,
    result: { scouting_run_id: RUN, observation_id: OBS }
  })], { id: OTHER, idempotency_key: OTHER });
  const data = buildRunPersonalSyncHistory({ data: [a, b] }, session(), RUN);
  assert.equal(data.confirmed, 0);
  assert.equal(data.unverified, 2);
  assert.equal(data.entries[0].observationId, null);
  assert.equal(data.entries[1].observationId, null);
});

test('only 100 latest own batch receipts are considered; timestamps never fabricated', () => {
  const rows = Array.from({ length: 100 }, (_, i) => batch([], {
    id: generateUuid(i + 1), idempotency_key: generateUuid(i + 101)
  }));
  const model = buildRunPersonalSyncHistory({ data: rows }, session(), RUN);
  assert.equal(model.receiptWindow, 100);
  assert.equal(model.atLimit, true);
  assert.equal(model.entries.length, 0);
  assert.throws(() => buildRunPersonalSyncHistory({ data: [...rows, batch([])] }, session(), RUN));
  const undated = buildRunPersonalSyncHistory({ data: [batch([operation()], {
    processed_at: 'bad date', received_at: null
  })] }, session(), RUN);
  assert.equal(undated.entries[0].timestamp, null);
});

test('history presentation contains no source payload, notes, GPS or photo evidence', () => {
  const source = operation(RUN, { payload: { notes: 'SECRET FIELD NOTES',
    point: { type: 'Point', coordinates: [-57.94, -34.92] } } });
  const model = buildRunPersonalSyncHistory({ data: [batch([source])] }, session(), RUN);
  const output = JSON.stringify(model);
  for (const secret of ['SECRET FIELD NOTES', '-57.94', '-34.92', 'content_base64', 'filename']) {
    assert.ok(!output.includes(secret));
  }
  assert.equal(model.entries[0].status, 'confirmed');
});
