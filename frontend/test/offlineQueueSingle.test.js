import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingObservation } from '../src/services/offlineSyncModel.js';
import { createOfflineQueue } from '../src/services/offlineQueue.js';

const TENANT = '8924317c-240c-4bda-93c9-e717749c87ec';
const OTHER_TENANT = '7089af3f-11ad-4e59-aeea-e289c8012e97';
const ACTOR = 'e12838dc-dba6-4c88-a3d3-d4227bed0153';
const OTHER_ACTOR = 'd763ad5f-76aa-4af3-952d-f9a5a965f4f7';
const RUN_A = 'f9520c7a-259b-47ae-98d0-0a4988d8d212';
const RUN_B = '1515f182-8700-4b70-a926-0d9348bf5ce8';
const OBS = 'ee281abd-2312-4791-b76a-1fb0164c46d7';
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
const session = (tenant = TENANT, actor = ACTOR) =>
  ({ authenticated: true, tenant: { id: tenant }, user: { id: actor } });
let seed = 10;
function pending(runId = RUN_A, photo = false) {
  let idx = 0;
  const key = String(seed++).padStart(12, '0');
  return createPendingObservation({
    session: session(), runId,
    values: {
      observation_type: 'pest', severity: 'medium', notes: 'Private field observation',
      ...(photo ? { photo: { original_name: 'campo.png', mime_type: 'image/png',
        content_base64: PNG } } : {})
    },
    uuid: () => [
      `0a8badef-1b9d-4d53-a7b5-${key}`,
      `17482796-673c-4c02-acd0-${key}`,
      `abc24513-f728-4cbc-a022-${key}`
    ][idx++],
    now: new Date('2026-10-14T12:00:00Z')
  });
}
function ack(body) {
  return { replayed: false, data: {
    id: '2844c701-fc1f-4354-93a1-30aad645663e',
    client_id: body.client_id,
    status: 'processed', idempotency_key: body.idempotency_key,
    operations: body.operations.map(op => ({
      entity_client_id: op.entity_client_id, status: 'applied',
      result: {
        observation_id: OBS,
        scouting_run_id: op.payload.scouting_run_id,
        field_id: TENANT
      }
    }))
  } };
}
function harness(opts = {}) {
  const records = new Map();
  const notifications = [];
  let online = opts.online !== false;
  const store = {
    get: async id => structuredClone(records.get(id)),
    list: async scope => [...records.values()].filter(d => d.scope === scope)
      .map(row => structuredClone(row)),
    put: async row => { records.set(row.id, structuredClone(row)); },
    delete: async id => { records.delete(id); }
  };
  const queue = createOfflineQueue({
    store,
    isOnline: () => online,
    notify: () => notifications.push('changed'),
    now: () => new Date('2026-10-14T12:00:00Z'),
    ...(opts.withLock ? { withLock: opts.withLock } : {})
  });
  return { queue, records, notifications, setOnline: value => { online = value; } };
}

test('select one pending draft: only its immutable batch is posted, others remain untouched', async () => {
  const h = harness();
  const a = pending(RUN_A), b = pending(RUN_B), c = pending(RUN_A);
  for (const item of [a,b,c]) h.records.set(item.id, item);
  const before = JSON.stringify(b);
  const calls = [];
  const result = await h.queue.flushOne(session(), c.id, async body => {
    calls.push(body);
    return ack(body);
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(calls, [c.body]);
  assert.equal(h.records.size, 2);
  assert.equal(h.records.has(c.id), false);
  assert.equal(JSON.stringify(h.records.get(b.id)), before);
  assert.deepEqual([...h.records.keys()].sort(), [a.id,b.id].sort());
});

test('manually reviewed conflict/auth targets can retry without unlocking unrelated conflicts', async () => {
  for (const state of ['auth', 'conflict']) {
    const h = harness();
    const target = { ...pending(), state, errorCode: 'SCOUTING_RUN_CLOSED',
      attempts: 5, nextRetryAt: null };
    const unrelated = { ...pending(RUN_B), state: 'conflict' };
    h.records.set(target.id, target);
    h.records.set(unrelated.id, unrelated);
    let calls = 0;
    const result = await h.queue.flushOne(session(), target.id, async body => {
      calls += 1;
      assert.equal(body.idempotency_key, target.idempotencyKey);
      return ack(body);
    });
    assert.equal(result.sent, 1);
    assert.equal(calls, 1);
    assert.deepEqual(h.records.get(unrelated.id), unrelated);
  }
});

test('401/409 failures preserve original bytes and stable idempotency key on single retry', async () => {
  for (const [code, expected] of [[401, 'auth'], [409, 'conflict']]) {
    const h = harness();
    const target = pending(RUN_A, true);
    h.records.set(target.id, target);
    const original = JSON.stringify(target.body);
    const outcome = await h.queue.flushOne(session(), target.id, async () => {
      throw Object.assign(new Error('server refused'), { status: code });
    }, { sendEvidence: async () => { throw Error('should not run'); } });
    assert.equal(outcome.attempted, 1);
    assert.equal(outcome.sent, 0);
    assert.equal(h.records.get(target.id).state, expected);
    assert.equal(JSON.stringify(h.records.get(target.id).body), original);
    assert.equal(h.records.get(target.id).evidence.content_base64, PNG);
    assert.equal(h.records.get(target.id).evidence.client_upload_id,
      target.evidence.client_upload_id);
  }
});

test('network-lost ACK keeps a retryable draft with the original id and payload', async () => {
  const h = harness(); const item = pending();
  h.records.set(item.id, item);
  const outcome = await h.queue.flushOne(session(), item.id, async () => {
    throw new TypeError('lost response after PostgreSQL commit');
  });
  assert.equal(outcome.sent, 0);
  assert.equal(outcome.attempted, 1);
  const persisted = h.records.get(item.id);
  assert.equal(persisted.state, 'pending');
  assert.equal(persisted.idempotencyKey, item.idempotencyKey);
  assert.deepEqual(persisted.body, item.body);
  assert.ok(persisted.nextRetryAt);
});

test('photo already linked to server observation cannot resend its batch in the one-shot path', async () => {
  const h = harness(); const item = { ...pending(RUN_A, true), syncedObservationId: OBS };
  h.records.set(item.id, item);
  let sent = 0;
  const outcome = await h.queue.flushOne(session(), item.id, async () => {
    sent++; throw Error('must not call batch API');
  }, { sendEvidence: async () => { sent++; throw Error('must not call photo API'); } });
  assert.equal(outcome.photoRecoveryRequired, true);
  assert.equal(outcome.attempted, 0);
  assert.equal(sent, 0);
  assert.deepEqual(h.records.get(item.id), item);
});

test('selected send rejects any other tenant or actor and never reads unrelated rows', async () => {
  const h = harness(); const item = pending();
  h.records.set(item.id, item);
  let count = 0;
  const sender = async () => { count++; return ack(item.body); };
  await assert.rejects(h.queue.flushOne(session(OTHER_TENANT), item.id, sender), /otra cuenta/);
  await assert.rejects(h.queue.flushOne(session(TENANT, OTHER_ACTOR), item.id, sender), /otra cuenta/);
  await assert.rejects(h.queue.flushOne(session(), 'evil', sender), /ID válido/);
  assert.equal(count, 0);
  assert.deepEqual(h.records.get(item.id), item);
});

test('missing/deleted selected record does not generate new data or post a batch', async () => {
  const h = harness(), item = pending();
  let calls = 0;
  const result = await h.queue.flushOne(session(), item.id, async () => {
    calls++; throw Error('must never send');
  });
  assert.equal(result.missing, true);
  assert.equal(result.sent, 0);
  assert.equal(calls, 0);
  assert.equal(h.records.size, 0);
});

test('tampered draft run, entity, idempotency and malformed operations block network', async () => {
  const seedRecord = pending();
  for (const tamper of [
    { ...seedRecord, runId: RUN_B },
    { ...seedRecord, body: { ...seedRecord.body, idempotency_key: seedRecord.body.operations[0].entity_client_id } },
    { ...seedRecord, body: { ...seedRecord.body, operations: [] } },
    { ...seedRecord, body: { ...seedRecord.body, operations: [
      { ...seedRecord.body.operations[0], operation: 'update' }
    ] } },
    { ...seedRecord, body: { ...seedRecord.body, operations: [
      { ...seedRecord.body.operations[0], payload: {
        ...seedRecord.body.operations[0].payload, scouting_run_id: RUN_B
      } }
    ] } }
  ]) {
    const h = harness(); h.records.set(tamper.id, tamper);
    let calls = 0;
    const outcome = await h.queue.flushOne(session(), seedRecord.id, async () => {
      calls++; throw Error('must not call');
    });
    assert.equal(outcome.invalidDraft, true);
    assert.equal(calls, 0);
    assert.deepEqual(h.records.get(tamper.id), tamper);
  }
});

test('other concurrent flush within same tab returns skipped; only one selected batch is sent', async () => {
  const h = harness(); const item = pending();
  h.records.set(item.id, item);
  let started, release;
  const begun = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = h.queue.flushOne(session(), item.id, async body => {
    calls++; started(); await waiting; return ack(body);
  });
  await begun;
  const overlapping = await h.queue.flushOne(session(), item.id, async body => {
    calls++; return ack(body);
  });
  const global = await h.queue.flush(session(), async body => {
    calls++; return ack(body);
  }, { force: true });
  assert.equal(overlapping.skipped, true);
  assert.equal(global.skipped, true);
  release();
  assert.equal((await first).sent, 1);
  assert.equal(calls, 1);
});

test('when cross-tab navigator lock is unavailable, chosen work returns skipped', async () => {
  const h = harness({ withLock: async () => ({
    attempted: 0, sent: 0, conflicts: 0, skipped: true
  }) });
  const item = pending(); h.records.set(item.id, item);
  const result = await h.queue.flushOne(session(), item.id,
    async () => { throw Error('must not send'); });
  assert.equal(result.skipped, true);
  assert.deepEqual(h.records.get(item.id), item);
});

test('offline single send skips without modifying local state', async () => {
  const h = harness({ online: false }); const item = pending();
  h.records.set(item.id, item);
  let called = false;
  const result = await h.queue.flushOne(session(), item.id, async () => {
    called = true;
  });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
  assert.deepEqual(h.records.get(item.id), item);
});
