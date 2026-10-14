import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingObservation } from '../src/services/offlineSyncModel.js';
import { createOfflineQueue } from '../src/services/offlineQueue.js';
import { planConfirmedPhotoRecovery, verifiedPhotoUpload } from '../src/services/photoRecovery.js';

const TENANT = 'a34eadf8-375c-4aba-95df-bcc15a6fd9a4';
const ACTOR = 'ca1aa3b1-4850-4128-8d8f-bfbbe0e39c86';
const OTHER = 'eb2f4a32-0a67-4970-b126-7cbe914ce2b6';
const RUN = '167b86e0-45b2-4d0f-adfe-d61e941938e5';
const OBS = '35744828-46fc-4267-853c-ef7e4f6859d4';
const UPLOAD_ID = 'db51a425-82e6-4332-9d1d-29e6f905995f';
const ASSET = '7a576dfa-1587-44c5-bc98-b1c45f2b2dc1';
const KEY = 'a3459fcb-aa7c-4ba5-8cc2-b66ec3a87ca0';
const OP = '3a03c551-6fdc-4c7d-81a1-887de91942fa';
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
const session = (actor = ACTOR, tenant = TENANT) =>
  ({ token: 'fake-test', user: { id: actor }, tenant: { id: tenant } });

function draft() {
  const uids = [KEY, OP, UPLOAD_ID];
  let index = 0;
  return createPendingObservation({
    session: session(), runId: RUN,
    values: { observation_type: 'pest', severity: 'high',
      notes: 'Private field notes', point: { type: 'Point', coordinates: [-57.95, -34.92] },
      photo: { original_name: 'lote.png', mime_type: 'image/png', content_base64: PNG }
    },
    uuid: () => uids[index++],
    now: new Date('2026-10-14T17:00:00Z')
  });
}

function receipt(d, changes = {}) {
  return {
    id: '09dcd498-e4e1-45c6-b174-2173ade0525a',
    client_id: d.body.client_id, submitted_by: ACTOR,
    idempotency_key: d.idempotencyKey,
    status: 'processed',
    SyncOperations: [{ entity_type: 'scouting_observation',
      entity_client_id: OP, operation: 'create', status: 'applied',
      result: { observation_id: OBS, scouting_run_id: RUN } }],
    ...changes
  };
}

function ack(d, changes = {}) {
  return { data: {
    id: ASSET, client_upload_id: UPLOAD_ID, scouting_observation_id: OBS,
    uploaded_by: ACTOR, kind: 'photo', mime_type: 'image/png',
    original_name: 'lote.png', size_bytes: 12,
    ...changes
  }, replayed: false };
}

function harness({ online = true, withLock } = {}) {
  const stored = new Map();
  const notifications = [];
  const queue = createOfflineQueue({
    store: {
      get: async id => structuredClone(stored.get(id)),
      put: async value => { stored.set(value.id, structuredClone(value)); },
      list: async scope => [...stored.values()].filter(row => row.scope === scope),
      delete: async id => { stored.delete(id); }
    },
    notify: () => { notifications.push('updated'); },
    isOnline: () => online,
    now: () => new Date('2026-10-14T17:00:00Z'),
    ...(withLock ? { withLock } : {})
  });
  return { stored, queue, notifications };
}

test('recovery plan requires exact processed observation and ORIGINAL bounded photo ID', () => {
  const d = draft();
  const p = planConfirmedPhotoRecovery(d, receipt(d), session());
  assert.equal(p.observationId, OBS);
  assert.equal(p.clientUploadId, UPLOAD_ID);
  assert.equal(p.sizeBytes, 12);
  assert.equal(p.submittedBy, ACTOR);
  assert.throws(() => planConfirmedPhotoRecovery({ ...d, evidence: undefined }, receipt(d), session()));
  assert.throws(() => planConfirmedPhotoRecovery(d, receipt(d, { submitted_by: OTHER }), session()));
  assert.throws(() => planConfirmedPhotoRecovery(d, receipt(d), session(OTHER)));
  assert.throws(() => planConfirmedPhotoRecovery(d, receipt(d, {
    SyncOperations: [{ ...receipt(d).SyncOperations[0], status: 'failed' }]
  }), session()));
  assert.throws(() => planConfirmedPhotoRecovery({ ...d, evidence: {
    ...d.evidence, client_upload_id: 'bad-uuid'
  } }, receipt(d), session()));
});

test('independent photo ACK requires exact asset, actor, observation, UUID, size and MIME', () => {
  const d = draft();
  const plan = planConfirmedPhotoRecovery(d, receipt(d), session());
  assert.equal(verifiedPhotoUpload(ack(d), plan).evidenceId, ASSET);
  assert.equal(verifiedPhotoUpload({ ...ack(d), replayed: true }, plan).replayed, true);
  for (const changes of [
    { id: 'not-uuid' }, { uploaded_by: OTHER }, { client_upload_id: KEY },
    { scouting_observation_id: OTHER }, { size_bytes: 11 },
    { mime_type: 'image/jpeg' }, { original_name: 'otro.png' }, { kind: 'document' }
  ]) assert.throws(() => verifiedPhotoUpload(ack(d, changes), plan), /confirmó la fotografía/);
  assert.throws(() => verifiedPhotoUpload({ data: {} }, plan), /confirmó la fotografía/);
});

test('explicit photo-only retry never re-POSTs observation or changes its idempotency key', async () => {
  const h = harness();
  const d = draft();
  h.stored.set(d.id, d);
  const sent = [];
  const result = await h.queue.recoverPhoto(session(), d.id, receipt(d), async (id, evidence) => {
    sent.push({ id, upload: evidence.client_upload_id, image: evidence.content_base64 });
    return ack(d);
  });
  assert.deepEqual(sent, [{ id: OBS, upload: UPLOAD_ID, image: PNG }]);
  assert.equal(result.status, 'uploaded');
  assert.equal(result.replayed, false);
  assert.equal(h.stored.size, 0);
  assert.equal(h.notifications.length, 1);
});

test('idempotent 200 replay safely completes after lost first upload ACK', async () => {
  const h = harness();
  const d = draft();
  h.stored.set(d.id, d);
  const first = await h.queue.recoverPhoto(session(), d.id, receipt(d),
    async () => { throw Object.assign(new Error('Conexión perdida'), { status: 0 }); });
  assert.equal(first.status, 'pending');
  const waiting = h.stored.get(d.id);
  assert.equal(waiting.evidence.client_upload_id, UPLOAD_ID);
  assert.equal(waiting.evidence.content_base64, PNG);
  assert.equal(waiting.body.idempotency_key, KEY);
  assert.equal(waiting.nextRetryAt, '2026-10-14T17:00:05.000Z');
  const second = await h.queue.recoverPhoto(session(), d.id, receipt(d),
    async (_id, evidence) => {
      assert.equal(evidence.client_upload_id, UPLOAD_ID);
      return { ...ack(d), replayed: true };
    });
  assert.equal(second.status, 'uploaded');
  assert.equal(second.replayed, true);
  assert.equal(h.stored.size, 0);
});

test('invalid upload response, 401 and 409 preserve encrypted content and review state', async () => {
  for (const [err, status, expectedState] of [
    [null, null, 'pending'],
    [Object.assign(new Error('Sesión expirada'), { status: 401 }), 401, 'auth'],
    [Object.assign(new Error('EVIDENCE_UPLOAD_CONFLICT'), { status: 409,
      code: 'EVIDENCE_UPLOAD_CONFLICT' }), 409, 'conflict']
  ]) {
    const h = harness();
    const d = draft(); h.stored.set(d.id, d);
    const outcome = await h.queue.recoverPhoto(session(), d.id, receipt(d),
      async () => {
        if (status !== null) throw err;
        return ack(d, { size_bytes: 500 });
      });
    assert.equal(outcome.status, expectedState);
    assert.equal(h.stored.size, 1);
    const pending = h.stored.get(d.id);
    assert.equal(pending.state, expectedState);
    assert.equal(pending.evidence.content_base64, PNG);
    assert.equal(pending.evidence.client_upload_id, UPLOAD_ID);
    assert.equal(pending.attempts, 1);
  }
});

test('no request on offline, wrong tenant, unprocessed or unverified receipt', async () => {
  const d = draft();
  const offline = harness({ online: false });
  offline.stored.set(d.id, d);
  assert.deepEqual(await offline.queue.recoverPhoto(session(), d.id, receipt(d),
    async () => { throw Error('Should never call'); }), { status: 'offline' });
  const h = harness(); h.stored.set(d.id, d);
  let calls = 0;
  const callback = async () => { calls++; return ack(d); };
  await assert.rejects(h.queue.recoverPhoto(session(OTHER), d.id, receipt(d), callback),
    /otra sesión/);
  await assert.rejects(h.queue.recoverPhoto(session(), d.id, receipt(d, {
    status: 'received'
  }), callback), /confirmación verificable/);
  assert.equal(calls, 0);
  assert.equal(h.stored.size, 1);
});

test('two tab-like submissions are serialized; second cannot send the photo again', async () => {
  const h = harness();
  const d = draft(); h.stored.set(d.id, d);
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const sender = async () => { calls++; entered(); await blocked; return ack(d); };
  const first = h.queue.recoverPhoto(session(), d.id, receipt(d), sender);
  await started;
  assert.equal((await h.queue.recoverPhoto(session(), d.id, receipt(d), sender)).status, 'busy');
  release();
  assert.equal((await first).status, 'uploaded');
  assert.equal(calls, 1);
  assert.equal(h.stored.size, 0);
});

test('missing row and concurrent draft mutation never resurrect or remove newer bytes', async () => {
  const h = harness();
  const d = draft();
  assert.equal((await h.queue.recoverPhoto(session(), d.id, receipt(d),
    async () => ack(d))).status, 'missing');
  h.stored.set(d.id, d);
  const result = await h.queue.recoverPhoto(session(), d.id, receipt(d), async () => {
    h.stored.set(d.id, { ...d, evidence: { ...d.evidence, content_base64: 'replaced-image' } });
    return ack(d);
  });
  assert.equal(result.status, 'changed');
  assert.equal(h.stored.get(d.id).evidence.content_base64, 'replaced-image');
});
