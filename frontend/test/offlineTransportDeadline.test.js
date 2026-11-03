import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  withOfflineTransportDeadline, OFFLINE_BATCH_DEADLINE_MS, OFFLINE_PHOTO_DEADLINE_MS
} from '../src/services/offlineTransportDeadline.js';
import { createOfflineQueue } from '../src/services/offlineQueue.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const OBS = '44444444-4444-4444-8444-444444444444';
const session = { authenticated: true, tenant: { id: TENANT }, user: { id: USER } };
const values = {
  observation_type: 'pest', severity: 'medium', notes: 'test-only field note',
  observed_at: '2026-10-24T10:00:00Z'
};
function harness() {
  const records = new Map();
  const store = {
    get: async id => structuredClone(records.get(id)),
    list: async scope => [...records.values()].filter(row => row.scope === scope)
      .map(row => structuredClone(row)),
    put: async row => { records.set(row.id, structuredClone(row)); return true; },
    delete: async id => records.delete(id)
  };
  let key = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++key).padStart(12,'0')}`;
  const queue = createOfflineQueue({ store, uuid });
  return { queue, records };
}
const receipt = body => ({
  replayed: true,
  data: {
    id: '55555555-5555-4555-8555-555555555555',
    client_id: body.client_id, idempotency_key: body.idempotency_key,
    status: 'processed',
    operations: body.operations.map(op => ({
      entity_client_id: op.entity_client_id, status: 'applied',
      result: { observation_id: OBS, scouting_run_id: RUN, field_id: TENANT }
    }))
  }
});

test('normal offline request propagates a live signal and settles before its deadline', async () => {
  assert.ok(OFFLINE_BATCH_DEADLINE_MS > 12000);
  assert.ok(OFFLINE_PHOTO_DEADLINE_MS >= OFFLINE_BATCH_DEADLINE_MS);
  let captured;
  const result = await withOfflineTransportDeadline(async signal => {
    captured = signal;
    assert.equal(signal.aborted, false);
    return { replayed: false };
  }, { timeoutMs: 35 });
  assert.deepEqual(result, { replayed: false });
  assert.equal(captured.aborted, false, 'success must clear its timeout');
});

test('a never-settling transport cannot hold an account-scope lock forever', async () => {
  let observedSignal;
  const started = Date.now();
  await assert.rejects(
    withOfflineTransportDeadline(signal => {
      observedSignal = signal;
      return new Promise(() => {}); // Transport ignores abort; wrapper still settles.
    }, { timeoutMs: 18 }),
    error => error.name === 'AbortError'
  );
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - started < 700, 'bounded timeout resolves even without fetch abort support');
});

test('parent logout aborts a pending request; an already-aborted cookie never starts transport', async () => {
  const parent = new AbortController();
  let captured;
  const flight = withOfflineTransportDeadline(signal => {
    captured = signal;
    return new Promise(() => {});
  }, { timeoutMs: 2000, signal: parent.signal });
  parent.abort(new DOMException('Logout', 'AbortError'));
  await assert.rejects(flight, error => error.name === 'AbortError');
  assert.equal(captured?.aborted, true);
  let calls = 0;
  await assert.rejects(withOfflineTransportDeadline(() => {
    calls++;
  }, { timeoutMs: 20, signal: parent.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 0, 'revoked user cannot initiate a new network request');
});

test('invalid limits fail closed before invoking transport', async () => {
  for (const timeoutMs of [0, -1, 1.2, Number.NaN, 120001]) {
    await assert.rejects(withOfflineTransportDeadline(() => {
      throw Error('should not invoke');
    }, { timeoutMs }), /Parámetros inválidos/);
  }
});

test('timeout of an automatic batch preserves ciphertext semantics and manual replays original UUID', async () => {
  const h = harness();
  const item = await h.queue.queueObservation(session, RUN, values);
  let attempts = 0;
  const first = await h.queue.flush(session, body => {
    attempts++;
    assert.equal(body.idempotency_key, item.idempotencyKey);
    return withOfflineTransportDeadline(() => new Promise(() => {}), { timeoutMs: 14 });
  });
  assert.equal(first.sent, 0);
  assert.equal(attempts, 1);
  const saved = (await h.queue.list(session))[0];
  assert.equal(saved.idempotencyKey, item.idempotencyKey);
  assert.deepEqual(saved.body, item.body);
  assert.equal(saved.state, 'pending');
  assert.equal(saved.attempts, 1);
  const retried = await h.queue.flush(session, body => {
    attempts++;
    assert.deepEqual(body, item.body);
    return receipt(body);
  }, { force: true, waitForBusy: true });
  assert.equal(retried.sent, 1);
  assert.equal(attempts, 2);
  assert.equal((await h.queue.list(session)).length, 0);
});

test('timeout after a committed observation keeps photo-only recovery and original upload identity', async () => {
  const h = harness();
  const photo = { original_name:'sample.jpg', mime_type:'image/jpeg',
    content_base64: Buffer.from([255,216,255,217]).toString('base64') };
  const item = await h.queue.queueObservation(session, RUN, { ...values, photo });
  let batches = 0;
  const result = await h.queue.flush(session, body => {
    batches++;
    return receipt(body);
  }, { sendEvidence: () => withOfflineTransportDeadline(
    () => new Promise(() => {}), { timeoutMs: 14 })
  });
  assert.equal(result.sent, 0);
  const saved = (await h.queue.list(session))[0];
  assert.equal(saved.syncedObservationId, OBS);
  assert.equal(saved.evidence.client_upload_id, item.evidence.client_upload_id);
  assert.equal(saved.evidence.content_base64, item.evidence.content_base64);
  const manual = await h.queue.flushOne(session, saved.id, async () => {
    batches++;
    throw Error('Cannot repost an applied observation');
  });
  assert.equal(manual.photoRecoveryRequired, true);
  assert.equal(batches, 1);
});

test('only offline write endpoints adopt a deadline; no generic session or GET timeout', () => {
  const api = readFileSync(new URL('../src/services/api.js',import.meta.url),'utf8');
  const sync = api.slice(api.indexOf('submitSyncBatch:'),api.indexOf('notifications:',api.indexOf('submitSyncBatch:')));
  const evidence = api.slice(api.indexOf('submitOfflineEvidence:'),api.indexOf('getEvidenceContent:',api.indexOf('submitOfflineEvidence:')));
  assert.match(sync, /withOfflineTransportDeadline/);
  assert.match(sync, /OFFLINE_BATCH_DEADLINE_MS/);
  assert.match(evidence, /withOfflineTransportDeadline/);
  assert.match(evidence, /OFFLINE_PHOTO_DEADLINE_MS/);
  assert.match(sync, /signal: options.signal/);
  assert.match(evidence, /signal: options.signal/);
  const session = api.slice(api.indexOf('me: () =>'),api.indexOf('logout: () =>'));
  assert.doesNotMatch(session, /withOfflineTransportDeadline/);
});
