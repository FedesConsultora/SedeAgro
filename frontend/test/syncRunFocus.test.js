import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSyncRunFocus, filterSyncRunDrafts, filterSyncRunReceipts
} from '../src/services/syncRunFocus.js';

const TENANT = '60eadc4c-5b10-49f2-98f1-79dd9c95a4b1';
const USER = '9b083101-7613-4faf-8dbc-d7e530ec45aa';
const RUN = '161aae50-7968-4fb8-bd3c-e575d053966c';
const OTHER = '39d67438-df83-4490-a859-73dfa3983ef7';
const SCOPE = `${TENANT}:${USER}`;
const focus = resolveSyncRunFocus(RUN);
const draft = (id, runId, scope = SCOPE) => ({
  id: `${scope}:${id}`, scope, runId,
  body: { operations: [{ payload: { scouting_run_id: runId } }] }
});
const receipt = (id, results) => ({
  id, client_id: 'sedeagro-web-offline-v1',
  SyncOperations: results.map(result => ({ result }))
});

test('UUID run focus is valid; missing focus shows all; invalid focus never expands', () => {
  assert.deepEqual(focus, { mode: 'run', runId: RUN });
  assert.deepEqual(resolveSyncRunFocus(RUN.toUpperCase()), { mode: 'run', runId: RUN });
  assert.deepEqual(resolveSyncRunFocus(), { mode: 'all', runId: null });
  assert.deepEqual(resolveSyncRunFocus(null), { mode: 'all', runId: null });
  for (const input of ['', 'all', '../admin', RUN + 'x', { runId: RUN }, 42]) {
    assert.deepEqual(resolveSyncRunFocus(input), { mode: 'invalid', runId: null });
  }
});

test('local draft focus is isolated by account and run, with no mutation', () => {
  const rows = [
    draft('first', RUN), draft('second', OTHER),
    draft('other-tenant', RUN, `${OTHER}:${USER}`),
    draft('other-user', RUN, `${TENANT}:${OTHER}`)
  ];
  const before = structuredClone(rows);
  assert.deepEqual(filterSyncRunDrafts(rows, SCOPE, focus).map(x => x.id), [rows[0].id]);
  assert.deepEqual(filterSyncRunDrafts(rows, SCOPE, resolveSyncRunFocus()).map(x => x.id),
    [rows[0].id, rows[1].id]);
  assert.deepEqual(rows, before);
  assert.deepEqual(filterSyncRunDrafts(rows, SCOPE, resolveSyncRunFocus('bad')), []);
  assert.deepEqual(filterSyncRunDrafts(rows, null, focus), []);
  assert.deepEqual(filterSyncRunDrafts('not-an-array', SCOPE, focus), []);
});

test('incomplete or inconsistent offline payload cannot be assigned to the chosen run', () => {
  const missingBody = { ...draft('a', RUN), body: null };
  const differentPayload = {
    ...draft('b', RUN),
    body: { operations: [{ payload: { scouting_run_id: OTHER } }] }
  };
  const multi = { ...draft('c', RUN), body: {
    operations: [{ payload: { scouting_run_id: RUN } }, { payload: { scouting_run_id: RUN } }]
  } };
  assert.deepEqual(filterSyncRunDrafts([missingBody, differentPayload, multi], SCOPE, focus), []);
});

test('only GET /sync/* SyncOperations.result.scouting_run_id can attribute receipts', () => {
  const matches = [
    receipt('applied', [{ scouting_run_id: RUN, observation_id: OTHER }]),
    receipt('other-run', [{ scouting_run_id: OTHER, observation_id: RUN }]),
    receipt('unattributed', [{}]),
    receipt('empty', []),
    { id: 'legacy', operations: [{ payload: { scouting_run_id: RUN } }] },
    { id: 'client-name-guess', client_id: RUN, SyncOperations: null },
    receipt('multi-run', [{ scouting_run_id: OTHER }, { scouting_run_id: RUN }])
  ];
  assert.deepEqual(filterSyncRunReceipts(matches, focus).map(x => x.id), ['applied', 'multi-run']);
  assert.equal(filterSyncRunReceipts(matches, resolveSyncRunFocus()).length, matches.length);
  assert.deepEqual(filterSyncRunReceipts(matches, resolveSyncRunFocus('invalid')), []);
  assert.deepEqual(filterSyncRunReceipts(null, focus), []);
});

test('server batches are not mutated or inferred from client id, idempotency or status', () => {
  const rows = [
    { id: 'received', status: 'received', client_id: RUN, idempotency_key: RUN, SyncOperations: [{ result: null }] },
    { id: 'failed', status: 'failed', SyncOperations: [{ result: { scouting_run_id: OTHER } }] },
    { id: 'verified', status: 'processed', SyncOperations: [{ result: { scouting_run_id: RUN } }] }
  ];
  const original = structuredClone(rows);
  assert.deepEqual(filterSyncRunReceipts(rows, focus).map(x => x.id), ['verified']);
  assert.deepEqual(rows, original);
});
