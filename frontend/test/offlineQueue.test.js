import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineQueue } from '../src/services/offlineQueue.js';
import {
  classifySyncError, createPendingObservation, isEligibleForAutoRetry,
  QUEUE_CLIENT_ID, retryDelayMs, sessionScope
} from '../src/services/offlineSyncModel.js';

const T1 = 'f4bf75d7-edb1-4885-981f-60c968239655';
const T2 = 'bbcf6c34-31cd-4b2a-b529-cf162efc89d9';
const U1 = 'f5d78c1f-7881-4fd4-97ba-85e50b65be1d';
const U2 = 'db817c78-2e1d-4ed5-b33f-0a60a583af43';
const RUN = '72635d7d-f70a-44a3-b6a7-c0054247f266';
const session = (userId = U1, tenantId = T1) =>
  ({ token: 'test-only-jwt', tenant: { id: tenantId }, user: { id: userId } });
const values = { observation_type: 'pest', severity: 'high', notes: 'Insects in field', observed_at: '2026-10-14T12:30' };

function harness() {
  const records = new Map();
  const writes = [];
  const store = {
    get: async (id) => records.get(id),
    put: async (item) => { records.set(item.id, structuredClone(item)); writes.push(item.id); },
    delete: async (id) => { records.delete(id); },
    list: async (scope) => [...records.values()].filter((item) => item.scope === scope)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  };
  let id = 0;
  let online = true;
  let time = new Date('2026-10-14T12:00:00.000Z').getTime();
  let notifications = 0;
  const queue = createOfflineQueue({
    store, uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => new Date(time), isOnline: () => online,
    notify: () => { notifications++; }
  });
  return {
    queue, records, writes,
    setOnline: (value) => { online = value; },
    advance: (ms) => { time += ms; },
    notifications: () => notifications
  };
}
const receipt = (item) => ({
  data: {
    id: '7b76a312-a801-4140-beb6-1e68b02e3ee0',
    idempotency_key: item.idempotency_key,
    status: 'processed',
    operations: item.operations.map((operation) => ({
      entity_client_id: operation.entity_client_id, status: 'applied',
      result: { observation_id: '528676ab-aac7-4735-9ffd-20db5b22c0cf' }
    }))
  }
});

test('scope is bound to authenticated tenant and user, never to role or just tenant', async () => {
  assert.equal(sessionScope(session()), `${T1}:${U1}`);
  assert.equal(sessionScope({ ...session(), token: '' }), null);
  const h = harness();
  await h.queue.queueObservation(session(), RUN, values);
  assert.equal((await h.queue.list(session())).length, 1);
  assert.equal((await h.queue.list(session(U2))).length, 0);
  assert.equal((await h.queue.list(session(U1, T2))).length, 0);
  await assert.rejects(h.queue.discard(session(U2), [...h.records.keys()][0]), /otra sesión/);
  assert.equal((await h.queue.list(session())).length, 1);
});

test('queued body and idempotency key never change after a lost acknowledgment', async () => {
  const h = harness();
  const item = await h.queue.queueObservation(session(), RUN, values);
  assert.equal(item.body.client_id, QUEUE_CLIENT_ID);
  assert.equal(item.body.idempotency_key, item.idempotencyKey);
  assert.equal(item.body.operations[0].payload.scouting_run_id, RUN);
  assert.equal(item.body.operations[0].payload.notes, values.notes);
  const originalBody = JSON.stringify(item.body);
  let calls = 0;
  const sent = [];
  const send = async (body) => {
    calls++;
    sent.push(JSON.stringify(body));
    if (calls === 1) throw new TypeError('Network dropped after server committed');
    return receipt(body);
  };
  const first = await h.queue.flush(session(), send);
  assert.equal(first.sent, 0);
  let pending = await h.queue.list(session());
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'pending');
  assert.equal(pending[0].attempts, 1);
  assert.ok(pending[0].nextRetryAt);
  assert.equal((await h.queue.flush(session(), send)).attempted, 0, 'backoff respected');
  h.advance(5000);
  const second = await h.queue.flush(session(), send);
  assert.equal(second.sent, 1);
  assert.equal((await h.queue.list(session())).length, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], originalBody);
  assert.equal(sent[1], originalBody);
});

test('offline mode never sends; reconnect forces only eligible queued work', async () => {
  const h = harness();
  h.setOnline(false);
  await h.queue.queueObservation(session(), RUN, values);
  let calls = 0;
  const send = async (body) => { calls++; return receipt(body); };
  assert.equal((await h.queue.flush(session(), send)).skipped, true);
  assert.equal(calls, 0);
  h.setOnline(true);
  assert.equal((await h.queue.flush(session(), send)).sent, 1);
  assert.equal(calls, 1);
});

test('409 and 403 conflicts stay visible and are never silently replayed', async () => {
  const h = harness();
  const record = await h.queue.queueObservation(session(), RUN, values);
  const conflict = Object.assign(new Error('Recorrida cerrada'), { status: 409, code: 'SCOUTING_RUN_CLOSED' });
  assert.equal((await h.queue.flush(session(), async () => { throw conflict; })).conflicts, 1);
  const rows = await h.queue.list(session());
  assert.equal(rows[0].state, 'conflict');
  assert.equal(rows[0].errorCode, 'SCOUTING_RUN_CLOSED');
  assert.equal((await h.queue.flush(session(), async () => { throw Error('unexpected retry'); }, { force: true })).attempted, 0);
  await h.queue.allowRetry(session(), record.id);
  let changed = 0;
  assert.equal((await h.queue.flush(session(), async (body) => { changed++; return receipt(body); })).sent, 1);
  assert.equal(changed, 1);
  assert.equal((await h.queue.list(session())).length, 0);
});

test('401 pauses until manually resumed; 500 uses exponential bounded backoff', async () => {
  const h = harness();
  const item = await h.queue.queueObservation(session(), RUN, values);
  await h.queue.flush(session(), async () => {
    throw Object.assign(new Error('Expired session'), { status: 401 });
  });
  assert.equal((await h.queue.list(session()))[0].state, 'auth');
  assert.equal((await h.queue.flush(session(), async () => receipt(item.body), { force: true })).attempted, 0);
  await h.queue.allowRetry(session(), item.id);
  await h.queue.flush(session(), async () => { throw Object.assign(new Error('Server unavailable'), { status: 500 }); });
  assert.equal((await h.queue.list(session()))[0].state, 'pending');
  assert.equal(classifySyncError({ status: 422 }), 'conflict');
  assert.equal(classifySyncError({ status: 0 }), 'retry');
  assert.equal(retryDelayMs(1), 5000);
  assert.equal(retryDelayMs(100), 300000);
});

test('empty or incomplete acknowledgments are ambiguous and must retain durable data', async () => {
  const h = harness();
  const item = await h.queue.queueObservation(session(), RUN, values);
  const result = await h.queue.flush(session(), async () => ({
    data: { ...receipt(item.body).data, status: 'received' }
  }));
  assert.equal(result.sent, 0);
  assert.equal((await h.queue.list(session())).length, 1);
  assert.equal((await h.queue.list(session()))[0].state, 'pending');
});

test('two simultaneous flushes on one tab cannot send the same batch twice', async () => {
  const h = harness();
  await h.queue.queueObservation(session(), RUN, values);
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { started = resolve; });
  let sent = 0;
  const sender = async (body) => { sent++; started(); await gate; return receipt(body); };
  const first = h.queue.flush(session(), sender);
  await begun;
  const second = await h.queue.flush(session(), sender);
  assert.equal(second.skipped, true);
  release();
  assert.equal((await first).sent, 1);
  assert.equal(sent, 1);
});

test('invalid notes and invalid dates are rejected before any write', async () => {
  const h = harness();
  await assert.rejects(h.queue.queueObservation(session(), RUN, { ...values, notes: '   ' }), /descripción/i);
  await assert.rejects(h.queue.queueObservation(session(), RUN, { ...values, observed_at: 'not a date' }), /fecha/i);
  await assert.rejects(h.queue.queueObservation(session(), 'bad-id', values), /ID válido/);
  assert.equal(h.records.size, 0);
  const candidate = createPendingObservation({
    session: session(), runId: RUN, values,
    uuid: () => 'fe8f05fd-d08a-44cb-b699-9aeaf4d110b4'
  });
  assert.equal(isEligibleForAutoRetry(candidate), true);
});

test('queue enforces a bounded per-user draft quota', async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) await h.queue.queueObservation(session(), RUN, values);
  assert.equal((await h.queue.list(session())).length, 100);
  await assert.rejects(h.queue.queueObservation(session(), RUN, values), /límite de 100/);
});
