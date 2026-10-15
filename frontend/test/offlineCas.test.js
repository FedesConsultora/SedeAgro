import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineQueue } from '../src/services/offlineQueue.js';
import { createPendingObservation } from '../src/services/offlineSyncModel.js';

const ACTOR = 'c4907502-f65a-4779-b675-45840fb29025';
const TENANT = 'd00420af-b938-445c-b6d0-3ad4e4f2be7f';
const RUN = '92a113ec-8ca7-4c94-a3cb-e0401a0c3de4';
const OBS = 'dbd57612-8072-4d03-bfd0-aeb892a1fdc3';
const ASSET = 'eef856c6-5c23-4b7b-a09b-9ddf4c15cb6f';
const session = () => ({ authenticated: true, user: { id: ACTOR }, tenant: { id: TENANT } });
const PHOTO = { original_name: 'cosecha.png', mime_type: 'image/png',
  content_base64: Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64') };
let next = 1;
function draft(photo = false) {
  let i = 0;
  const id = String(next++).padStart(12, '0');
  const uuids = [
    `0a197536-987c-44cb-b0e5-${id}`,
    `1b498528-c945-41af-bc7a-${id}`,
    `2b599528-c945-41af-bc7a-${id}`
  ];
  return createPendingObservation({ session: session(), runId: RUN,
    values: { observation_type: 'pest', severity: 'medium',
      notes: 'observación original', ...(photo ? { photo: PHOTO } : {}) },
    now: new Date('2026-10-14T12:00:00Z'),
    uuid: () => uuids[i++]
  });
}
function serverAck(body) {
  return { data: { status: 'processed', idempotency_key: body.idempotency_key,
    operations: [{ status: 'applied', entity_client_id: body.operations[0].entity_client_id,
      result: { observation_id: OBS, scouting_run_id: RUN } }] } };
}
function receipt(d) {
  return { id: '8b3c48d1-f43a-4c20-9dc7-28164f16a0a6', submitted_by: ACTOR,
    idempotency_key: d.idempotencyKey, client_id: d.body.client_id, status: 'processed',
    SyncOperations: [{ entity_type: 'scouting_observation', operation: 'create',
      entity_client_id: d.body.operations[0].entity_client_id, status: 'applied',
      result: { observation_id: OBS, scouting_run_id: RUN } }] };
}
function evidenceAck(d) {
  return { data: { id: ASSET, client_upload_id: d.evidence.client_upload_id,
    scouting_observation_id: OBS, uploaded_by: ACTOR, kind: 'photo', mime_type: PHOTO.mime_type,
    original_name: PHOTO.original_name, size_bytes: 12 } };
}

// Fake atomic storage: each authenticated get owns a private revision token;
// put/delete compare expected revision inside ONE simulated commit step.
// Hooks model a separate tab writing at exactly the transaction boundary.
function harness() {
  const db = new Map();
  const revisions = new WeakMap();
  let counter = 0;
  let beforeMutation = null;
  let calls = 0;
  const observe = data => {
    if (!data) return undefined;
    const view = structuredClone(data.value);
    revisions.set(view, data.revision);
    return view;
  };
  const store = {
    get: async id => observe(db.get(id)),
    list: async scope => [...db.values()].filter(x => x.value.scope === scope).map(observe),
    put: async (value, { expected } = {}) => {
      if (beforeMutation) { const callback = beforeMutation; beforeMutation = null; callback(); }
      const old = db.get(value.id);
      if (expected && (!old || old.revision !== revisions.get(expected))) return false;
      if (!expected && old) throw Error('Duplicate local UUID');
      db.set(value.id, { value: structuredClone(value), revision: ++counter });
      return value.id;
    },
    delete: async (id, { expected } = {}) => {
      if (beforeMutation) { const callback = beforeMutation; beforeMutation = null; callback(); }
      const old = db.get(id);
      if (!expected || !old || old.revision !== revisions.get(expected)) return false;
      db.delete(id); return true;
    }
  };
  const queue = createOfflineQueue({ store, isOnline: () => true,
    now: () => new Date('2026-10-14T12:00:00Z') });
  return {
    queue, store, db,
    insert(value) { db.set(value.id, { value: structuredClone(value), revision: ++counter }); },
    replace(id, patch) {
      const existing = db.get(id);
      if (!existing) throw Error('Missing record');
      db.set(id, { value: { ...existing.value, ...patch }, revision: ++counter });
    },
    beforeMutation(fn) { beforeMutation = fn; },
    countCalls() { return calls; },
    sender(d) { calls++; return serverAck(d); }
  };
}

test('discard CAS rejects another tab update before transaction delete', async () => {
  const h = harness(), d = draft(true); h.insert(d);
  h.beforeMutation(() => h.replace(d.id, { lastError: 'another tab keeps photo' }));
  await assert.rejects(h.queue.discard(session(), d.id), /cambió en otra pestaña/);
  assert.equal(h.db.get(d.id).value.lastError, 'another tab keeps photo');
  assert.equal(h.db.get(d.id).value.evidence.content_base64, PHOTO.content_base64);
});

test('manual retry CAS cannot reset newer conflict state', async () => {
  const h = harness(), d = { ...draft(), state: 'auth' }; h.insert(d);
  h.beforeMutation(() => h.replace(d.id, { state: 'conflict', errorCode: 'SECOND_TAB_409' }));
  await assert.rejects(h.queue.allowRetry(session(), d.id), /Otra pestaña modificó/);
  assert.equal(h.db.get(d.id).value.errorCode, 'SECOND_TAB_409');
  assert.equal(h.db.get(d.id).value.state, 'conflict');
});

test('confirmed observation cleanup cannot delete same-row ciphertext replaced by another tab', async () => {
  const h = harness(), d = draft(); h.insert(d);
  h.beforeMutation(() => h.replace(d.id, { attempts: 22 }));
  assert.equal(await h.queue.confirmApplied(session(), d.id, receipt(d)), false);
  assert.equal(h.db.get(d.id).value.attempts, 22);
});

test('post-HTTP success does not delete or alter a concurrently modified observation', async () => {
  const h = harness(), d = draft(true); h.insert(d);
  const outcome = await h.queue.flushOne(session(), d.id, async body => {
    h.replace(d.id, { lastError: 'edited while POST in flight' });
    return h.sender(body);
  }, { sendEvidence: async () => { throw Error('should not upload changed photo'); } });
  assert.equal(outcome.sent, 0);
  assert.equal(h.countCalls(), 1);
  assert.equal(h.db.get(d.id).value.lastError, 'edited while POST in flight');
  assert.equal(h.db.get(d.id).value.syncedObservationId, undefined);
});

test('photo partial-success CAS cannot overwrite concurrent change at commit boundary', async () => {
  const h = harness(), d = draft(true); h.insert(d);
  h.beforeMutation(() => h.replace(d.id, { evidence: {
    ...d.evidence, original_name: 'changed-in-other-tab.png'
  } }));
  const outcome = await h.queue.flushOne(session(), d.id, async body => h.sender(body), {
    sendEvidence: async () => { throw Error('no photo upload after CAS failure'); }
  });
  assert.equal(outcome.sent, 0);
  assert.equal(h.db.get(d.id).value.evidence.original_name, 'changed-in-other-tab.png');
  assert.equal(h.db.get(d.id).value.syncedObservationId, undefined);
});

test('photo ACK after partial success cannot delete a later edited local record', async () => {
  const h = harness(), d = draft(true); h.insert(d);
  const outcome = await h.queue.flushOne(session(), d.id, async body => h.sender(body), {
    sendEvidence: async () => {
      h.replace(d.id, { lastError: 'another tab changed photo metadata' });
      return evidenceAck(d);
    }
  });
  assert.equal(outcome.sent, 0);
  assert.equal(h.db.get(d.id).value.syncedObservationId, OBS);
  assert.equal(h.db.get(d.id).value.lastError, 'another tab changed photo metadata');
});

test('ambiguous HTTP failure does not overwrite another tab retry progress', async () => {
  const h = harness(), d = draft(); h.insert(d);
  const outcome = await h.queue.flushOne(session(), d.id, async body => {
    h.replace(d.id, { attempts: 9, lastError: 'newer failure' });
    h.sender(body);
    throw new Error('lost ACK');
  });
  assert.equal(outcome.sent, 0);
  assert.equal(h.db.get(d.id).value.attempts, 9);
  assert.equal(h.db.get(d.id).value.lastError, 'newer failure');
});

test('same plaintext but a different encrypted revision blocks stale deletion', async () => {
  const h = harness(), d = draft(); h.insert(d);
  const outcome = await h.queue.flushOne(session(), d.id, async body => {
    h.replace(d.id, {}); // same JSON plaintext but a fresh ciphertext revision
    return h.sender(body);
  });
  assert.equal(outcome.sent, 0);
  assert.ok(h.db.has(d.id));
});

test('recovery ACK cannot erase a newer photo revision even if bytes are identical', async () => {
  const h = harness(), d = { ...draft(true), syncedObservationId: OBS }; h.insert(d);
  h.beforeMutation(() => h.replace(d.id, {}));
  const result = await h.queue.recoverPhoto(session(), d.id, receipt(d), async () => evidenceAck(d));
  assert.equal(result.status, 'changed');
  assert.ok(h.db.has(d.id));
  assert.equal(h.db.get(d.id).value.evidence.client_upload_id, d.evidence.client_upload_id);
});

test('clean CAS success still completes observation, photo and retries without false failures', async () => {
  const h = harness(), d = draft(true); h.insert(d);
  const success = await h.queue.flushOne(session(), d.id, body => h.sender(body), {
    sendEvidence: async () => evidenceAck(d)
  });
  assert.equal(success.sent, 1);
  assert.equal(h.db.size, 0);
  const after = draft(); h.insert(after);
  assert.equal(await h.queue.confirmApplied(session(), after.id, receipt(after)), true);
  assert.equal(h.db.size, 0);
});
