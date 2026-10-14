import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingObservation } from '../src/services/offlineSyncModel.js';
import { runLocalCaptureSummary, LOCAL_CAPTURE_PHASES } from '../src/services/runOfflineCaptures.js';

const TENANT = 'b98fd053-58ba-4adf-b7cb-54e405c881d6';
const USER = 'a99ace3c-888c-4247-bc62-d1e251413e3f';
const OTHER = '977e8f18-39e5-4082-a5e8-0ae468df8f45';
const RUN = 'f7657e68-78a9-4243-ae2f-3c3f5eb7ea7e';
const RUN_2 = '48d7326b-9538-4711-8cfc-b557cf5d3fb6';
const CONFIRMED = '852257a9-51ce-40a3-a494-1db019a4d5c2';
const PNG = Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64');
const session = (tenant = TENANT, user = USER) =>
  ({ authenticated: true, tenant: { id: tenant }, user: { id: user } });
const VALUES = { observation_type: 'weed', severity: 'high',
  notes: 'Confidential pest notes — never show in status panel',
  point: { type: 'Point', coordinates: [-57.952, -34.92] }
};
let counter = 1;
function draft(runId = RUN, options = {}) {
  const id = String(counter++).padStart(12, '0');
  let n = 0;
  const record = createPendingObservation({
    session: session(), runId,
    values: { ...VALUES, ...options },
    now: new Date('2026-10-14T17:00:00.000Z'),
    uuid: () => [
      `abbefe17-e4dc-4914-80a8-${id}`,
      `d4cffb92-ac7e-4ed2-92f2-${id}`,
      `f5bd6287-5cfe-4eb4-a155-${id}`
    ][n++]
  });
  return record;
}
const PHOTO = { original_name: 'my-private-crop.png', mime_type: 'image/png', content_base64: PNG };

test('run status reports unsent observations separately from confirmed observations with pending photos', () => {
  const first = draft();
  const photo = { ...draft(RUN, { photo: PHOTO }), syncedObservationId: CONFIRMED };
  const v = runLocalCaptureSummary([first, photo], session(), RUN);
  assert.equal(v.total, 2);
  assert.equal(v.pendingObservations, 1);
  assert.equal(v.pendingPhotos, 1);
  assert.equal(v.review, 0);
  assert.equal(v.withGps, 2);
  assert.equal(v.entries.find(x => x.id === photo.id).phase, 'photo_pending');
  assert.equal(v.entries.find(x => x.id === first.id).phase, 'observation_pending');
});

test('conflict and authentication failures preserve the partial success of uploaded observation', () => {
  const p = draft(RUN, { photo: PHOTO });
  const v = runLocalCaptureSummary([
    { ...p, syncedObservationId: CONFIRMED, state: 'conflict' },
    { ...draft(RUN, { photo: PHOTO }), syncedObservationId: CONFIRMED, state: 'auth' },
    { ...draft(), state: 'conflict' },
    { ...draft(), state: 'auth' }
  ], session(), RUN);
  assert.deepEqual(v.entries.map(x => x.phase).sort(),
    ['authorization', 'photo_auth', 'photo_review', 'review']);
  assert.equal(v.pendingPhotos, 2);
  assert.equal(v.pendingObservations, 2);
  assert.equal(v.review, 4);
  assert.match(LOCAL_CAPTURE_PHASES.photo_review.help, /observación está aplicada/);
});

test('only the exact authorized run is returned; other runs and tenants never leak', () => {
  const first = draft();
  const otherRun = draft(RUN_2);
  const result = runLocalCaptureSummary([otherRun, first], session(), RUN);
  assert.equal(result.total, 1);
  assert.equal(result.entries[0].id, first.id);
  assert.throws(() => runLocalCaptureSummary([first], session(OTHER), RUN), /otra cuenta|cuenta activa|dañadas/);
  assert.throws(() => runLocalCaptureSummary([first], session(TENANT, OTHER), RUN), /cuenta activa|dañadas/);
  assert.throws(() => runLocalCaptureSummary([first], { tenant: { id: TENANT }, user: { id: USER } }, RUN), /cuenta, empresa/);
  assert.throws(() => runLocalCaptureSummary([first], session(), 'not-a-run'), /recorrida verificable/);
});

test('private notes, coordinates and photograph bytes do not appear in presentation results', () => {
  const p = draft(RUN, { photo: PHOTO });
  const result = runLocalCaptureSummary([p], session(), RUN);
  const serialized = JSON.stringify(result);
  for (const secret of [VALUES.notes, '-57.952', '-34.92', PNG, PHOTO.original_name]) {
    assert.ok(!serialized.includes(secret), 'must not expose '+secret);
  }
  assert.equal(result.entries[0].hasGps, true);
  assert.equal(result.entries[0].hasPhoto, true);
  assert.equal(result.entries[0].observationConfirmed, false);
  assert.equal(Object.hasOwn(result.entries[0], 'point'), false);
  assert.equal(Object.hasOwn(result.entries[0], 'evidence'), false);
});

test('invalid GPS indicators are not advertised as verified GPS positions', () => {
  const row = draft();
  row.body.operations[0].payload.point = { type: 'Point', coordinates: ['-57.9', -34.92] };
  assert.equal(runLocalCaptureSummary([row], session(), RUN).withGps, 0);
});

test('local queue malformation, unsupported operations and duplicate IDs fail closed', () => {
  const p = draft();
  for (const bad of [
    null, {}, { ...p, id: 'wrong-actor' }, { ...p, state: 'applied' },
    { ...p, idempotencyKey: 'bad' }, { ...p, body: null },
    { ...p, body: { ...p.body, operations: [] } },
    { ...p, body: { ...p.body, operations: [{ ...p.body.operations[0], operation: 'delete' }] } },
    { ...p, body: { ...p.body, operations: [{ ...p.body.operations[0], payload: { ...p.body.operations[0].payload, scouting_run_id: RUN_2 } }] } }
  ]) assert.throws(() => runLocalCaptureSummary([bad], session(), RUN));
  assert.throws(() => runLocalCaptureSummary([p, p], session(), RUN), /duplicados/);
  assert.throws(() => runLocalCaptureSummary(null, session(), RUN), /lista válida/);
  assert.throws(() => runLocalCaptureSummary(Array(101).fill(p), session(), RUN), /lista válida/);
});

test('newest observations appear first, but malformed dates do not claim a clock time', () => {
  const a = draft();
  const b = { ...draft(), createdAt: '2026-10-14T19:00:00Z' };
  const c = { ...draft(), createdAt: 'bad-date' };
  const v = runLocalCaptureSummary([a, b, c], session(), RUN);
  assert.equal(v.entries[0].id, b.id);
  assert.equal(v.entries.find(item => item.id === c.id).createdAt, null);
  assert.equal(v.total, 3);
});
