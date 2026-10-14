import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingObservation } from '../src/services/offlineSyncModel.js';
import { createOfflineQueue } from '../src/services/offlineQueue.js';
import {
  parseMySyncReceipts, reconcileOfflineDraft, RECONCILIATION_STATUS
} from '../src/services/offlineReconciliation.js';

const TENANT = 'b1835f9c-87c5-4fb4-894e-5fa2e8d6b58d';
const USER = 'e47e4314-88cd-4caf-8a35-5c31a9ee0ed1';
const OTHER = 'd75182af-ecdb-424b-974c-a1b01393df34';
const RUN = '167b86e0-45b2-4d0f-adfe-d61e941938e5';
const OBS = '35744828-46fc-4267-853c-ef7e4f6859d4';
const BATCH = '7d2775e5-315d-41e1-babb-988604abfd4b';
const KEY = '2b18499f-de8e-4423-a48d-3cf990a17abc';
const OP = 'dc17ac71-a724-4ca6-bdd9-a2b7917d0e35';
const session = (userId = USER, tenantId = TENANT) => ({
  authenticated: true, user: { id: userId }, tenant: { id: tenantId }
});
const values = { observation_type: 'weed', severity: 'high', notes: 'Monitoreo confirmado',
  point: { type: 'Point', coordinates: [-57.95, -34.92] } };
const ids = () => [KEY, OP][ids.index++ % 2];
const draft = (options = {}) => createPendingObservation({
  session: session(), runId: RUN, values: { ...values, ...options },
  uuid: (() => { let i = 0; return () => [KEY, OP][i++]; })(),
  now: new Date('2026-10-14T18:00:00Z')
});
const receipt = (d, changes = {}) => ({
  id: BATCH, idempotency_key: d.idempotencyKey, client_id: d.body.client_id,
  submitted_by: USER, status: 'processed',
  SyncOperations: [{
    entity_type: 'scouting_observation', entity_client_id: OP, operation: 'create',
    status: 'applied', result: { observation_id: OBS, scouting_run_id: RUN, field_id: TENANT }
  }],
  ...changes
});

test('only the signed-in actor receives their personal list (not the admin all-tenant listing)', () => {
  const d = draft();
  assert.deepEqual(parseMySyncReceipts({ data: [receipt(d)] }, session()).map(x => x.id), [BATCH]);
  for (const value of [
    { data: {} }, { data: null }, {}, { data: [receipt(d, { submitted_by: OTHER })] },
    { data: [receipt(d, { id: 'invalid' })] },
    { data: [receipt(d, { status: 'unknown' })] },
    { data: Array.from({ length: 101 }, () => receipt(d)) }
  ]) assert.throws(() => parseMySyncReceipts(value, session()), /recibos|datos inválidos/);
  assert.throws(() => parseMySyncReceipts({ data: [] }, { ...session(), authenticated: false }),
    /recibos verificables/);
});

test('complete batch and operation identities prove PostgreSQL application, including GPS', () => {
  const d = draft();
  const result = reconcileOfflineDraft(d, [receipt(d)], session());
  assert.equal(result.status, 'confirmed');
  assert.equal(result.observationId, OBS);
  assert.equal(result.batchId, BATCH);
  assert.deepEqual(d.body.operations[0].payload.point.coordinates, [-57.95, -34.92]);
  assert.match(RECONCILIATION_STATUS.confirmed.heading, /PostgreSQL/);
});

test('partial acknowledgement and unfinished server states never become confirmed', () => {
  const d = draft();
  assert.equal(reconcileOfflineDraft(d, [], session()).status, 'not_listed');
  assert.equal(reconcileOfflineDraft(d, [receipt(d, { status: 'received' })], session()).status, 'not_applied');
  assert.equal(reconcileOfflineDraft(d, [receipt(d, { status: 'processing' })], session()).status, 'not_applied');
  assert.equal(reconcileOfflineDraft(d, [receipt(d, { status: 'failed' })], session()).status, 'not_applied');
  assert.equal(reconcileOfflineDraft(d, [receipt(d, { SyncOperations: [] })], session()).status, 'ambiguous');
  assert.equal(reconcileOfflineDraft(d, [receipt(d), receipt(d)], session()).status, 'ambiguous');
  assert.match(RECONCILIATION_STATUS.not_listed.detail, /NO prueba/);
});

test('all key, operation, user, run, status, and observation mismatches fail closed', () => {
  const d = draft();
  const bad = [
    { client_id: 'other-device' },
    { submitted_by: OTHER },
    { id: 'bad-id' },
    { SyncOperations: [{ ...receipt(d).SyncOperations[0], status: 'failed' }] },
    { SyncOperations: [{ ...receipt(d).SyncOperations[0], entity_client_id: OTHER }] },
    { SyncOperations: [{ ...receipt(d).SyncOperations[0], entity_type: 'work_order' }] },
    { SyncOperations: [{ ...receipt(d).SyncOperations[0], operation: 'update' }] },
    { SyncOperations: [{ ...receipt(d).SyncOperations[0], result: { observation_id: OBS, scouting_run_id: OTHER } }] },
    { SyncOperations: [{ ...receipt(d).SyncOperations[0], result: { observation_id: 'fake-id', scouting_run_id: RUN } }] }
  ];
  for (const item of bad) {
    assert.notEqual(reconcileOfflineDraft(d, [receipt(d, item)], session()).status, 'confirmed');
  }
  assert.equal(reconcileOfflineDraft(d, [receipt(d)], session(OTHER)).status, 'unverified');
  assert.equal(reconcileOfflineDraft(d, [receipt(d)], session(USER, OTHER)).status, 'unverified');
  assert.equal(reconcileOfflineDraft(d, null, session()).status, 'unverified');
  assert.equal(reconcileOfflineDraft({ ...d, idempotencyKey: OTHER }, [receipt(d)], session()).status, 'unverified');
});

test('photo bytes are never treated as complete based solely on an observation receipt', () => {
  const d = { ...draft(), evidence: {
    original_name: 'campo.jpg', content_base64: 'private-base64',
    client_upload_id: OTHER
  }, syncedObservationId: OBS };
  const result = reconcileOfflineDraft(d, [receipt(d)], session());
  assert.equal(result.status, 'photo_pending');
  assert.equal(result.observationId, OBS);
  assert.equal(reconcileOfflineDraft({ ...d, syncedObservationId: OTHER },
    [receipt(d)], session()).status, 'ambiguous');
});

function harness() {
  const saved = new Map();
  let notifications = 0;
  const store = {
    get: async id => structuredClone(saved.get(id)),
    put: async item => { saved.set(item.id, structuredClone(item)); },
    delete: async id => { saved.delete(id); },
    list: async scope => [...saved.values()].filter(row => row.scope === scope)
  };
  const queue = createOfflineQueue({
    store, notify: () => { notifications += 1; }, isOnline: () => false
  });
  return { queue, saved, getNotifications: () => notifications };
}

test('explicit cleanup removes only the currently verified non-photo draft', async () => {
  const h = harness();
  const d = draft();
  h.saved.set(d.id, d);
  assert.equal(await h.queue.confirmApplied(session(), d.id, receipt(d)), true);
  assert.equal(h.saved.size, 0);
  assert.equal(h.getNotifications(), 1);
  assert.equal(await h.queue.confirmApplied(session(), d.id, receipt(d)), false);
});

test('cleanup never removes a photo, an unconfirmed operation or a different account', async () => {
  const h = harness();
  const d = draft();
  h.saved.set(d.id, d);
  await assert.rejects(h.queue.confirmApplied(session(OTHER), d.id, receipt(d)), /otra sesión/);
  await assert.rejects(h.queue.confirmApplied(session(), d.id, receipt(d, {
    SyncOperations: [{ ...receipt(d).SyncOperations[0], entity_client_id: OTHER }]
  })), /recibo completo/);
  assert.equal(h.saved.size, 1);
  h.saved.set(d.id, { ...d, evidence: { client_upload_id: OTHER, content_base64: 'private' } });
  await assert.rejects(h.queue.confirmApplied(session(), d.id, receipt(d)), /recibo completo/);
  assert.equal(h.saved.size, 1);
});

test('cleanup cannot run concurrently with an in-flight send or another cleanup', async () => {
  const saved = new Map();
  const d = draft();
  saved.set(d.id, d);
  let release;
  let entered;
  const start = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let count = 0;
  const queue = createOfflineQueue({
    store: {
      get: async id => {
        count += 1;
        if (count === 1) { entered(); await gate; }
        return saved.get(id);
      },
      delete: async id => { saved.delete(id); },
      list: async scope => [...saved.values()].filter(row => row.scope === scope),
      put: async item => { saved.set(item.id, item); }
    },
    isOnline: () => false
  });
  const first = queue.confirmApplied(session(), d.id, receipt(d));
  await start;
  assert.equal(await queue.confirmApplied(session(), d.id, receipt(d)), false);
  release();
  assert.equal(await first, true);
  assert.equal(saved.size, 0);
});
