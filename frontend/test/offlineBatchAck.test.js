import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedObservationBatchAck } from '../src/services/offlineSyncModel.js';

const RUN = 'ae63d2c6-dadf-4c86-9fd5-aa202c8ee3a4';
const OBS = '9b262388-eb8a-46d1-9622-f3d2ca38fae3';
const KEY = 'da00107b-51de-4dfc-a734-d939cbd555ac';
const OP = '6a8eb6b9-3cdf-4bfa-b62b-f8576fc00ca8';
const FIELD = '4f58a123-7af5-4a5b-b9a0-67ae545134f2';
const BATCH = '77fa0fca-21b8-4565-88d8-e93a44ac5b0c';

const draft = () => ({
  runId: RUN, idempotencyKey: KEY,
  body: {
    client_id: 'sedeagro-web-offline-v1', idempotency_key: KEY,
    operations: [{
      entity_type: 'scouting_observation', operation: 'create',
      entity_client_id: OP, payload: { scouting_run_id: RUN }
    }]
  }
});
const ack = () => ({
  replayed: false,
  data: {
    id: BATCH, client_id: 'sedeagro-web-offline-v1',
    idempotency_key: KEY, status: 'processed',
    operations: [{
      entity_client_id: OP, status: 'applied',
      result: { observation_id: OBS, scouting_run_id: RUN, field_id: FIELD }
    }]
  }
});

test('new and idempotent server receipts acknowledge only this exact observation and run', () => {
  assert.equal(verifiedObservationBatchAck(ack(), draft()), OBS);
  assert.equal(verifiedObservationBatchAck({ ...ack(), replayed: true }, draft()), OBS);
});

test('partial, wrong-run and cross-client 2xx ACKs never authorize local deletion', () => {
  const tamper = [
    ['missing batch', a => { delete a.data.id; }],
    ['wrong batch UUID', a => { a.data.id = 'fake'; }],
    ['wrong client', a => { a.data.client_id = 'other-client'; }],
    ['other idempotency key', a => { a.data.idempotency_key = OP; }],
    ['not applied', a => { a.data.status = 'received'; }],
    ['wrong op ID', a => { a.data.operations[0].entity_client_id = KEY; }],
    ['missing op', a => { a.data.operations = []; }],
    ['extra op', a => { a.data.operations.push(a.data.operations[0]); }],
    ['not applied op', a => { a.data.operations[0].status = 'failed'; }],
    ['invalid observation UUID', a => { a.data.operations[0].result.observation_id = 'claimed'; }],
    ['other run', a => { a.data.operations[0].result.scouting_run_id = OP; }],
    ['absent run', a => { delete a.data.operations[0].result.scouting_run_id; }],
    ['invalid field UUID', a => { a.data.operations[0].result.field_id = 'not-uuid'; }],
    ['no replay indication', a => { delete a.replayed; }]
  ];
  for (const [name, change] of tamper) {
    const result = ack();
    change(result);
    assert.throws(() => verifiedObservationBatchAck(result, draft()), /recibo.*observación exacta/, name);
  }
  for (const value of [null, undefined, {}, { data: {} }]) {
    assert.throws(() => verifiedObservationBatchAck(value, draft()), /recibo.*observación exacta/);
  }
});

test('client draft tampering cannot be authorized by a correctly formed server ACK', () => {
  const changes = [
    d => { d.runId = FIELD; },
    d => { d.idempotencyKey = OP; },
    d => { d.body.operations[0].payload.scouting_run_id = FIELD; },
    d => { d.body.operations[0].operation = 'update'; },
    d => { d.body.operations[0].entity_type = 'work_order'; },
    d => { d.body.operations[0].entity_client_id = BATCH; },
    d => { d.body.operations.push(d.body.operations[0]); },
    d => { d.body.operations = []; }
  ];
  for (const [index, change] of changes.entries()) {
    const d = draft();
    change(d);
    assert.throws(() => verifiedObservationBatchAck(ack(), d), /recibo.*observación exacta/, String(index));
  }
});
