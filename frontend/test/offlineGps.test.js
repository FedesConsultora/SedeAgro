import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPendingObservation } from '../src/services/offlineSyncModel.js';
import { validateObservationPoint } from '../src/services/observationLocation.js';

const RUN = '7a1c71a5-4c14-4784-87d0-b324d92e7eaa';
const UUID = '7b316d63-11b3-4f70-81bb-9f8348e2cf40';
const session = {
  authenticated: true,
  user: { id: 'field-worker-01' },
  tenant: { id: 'tenant-agro-01' }
};
const values = { observation_type: 'weed', severity: 'medium', notes: 'Maleza visible', observed_at: '2026-10-14T20:00:00Z' };
const make = v => createPendingObservation({ session, runId: RUN, values: v, uuid: () => UUID,
  now: new Date('2026-10-14T20:00:00Z') });

test('an optional GPS point survives the immutable offline sync payload without extraneous precision metadata', () => {
  const point = { type: 'Point', coordinates: [-57.9521, -34.9205] };
  const queued = make({ ...values, point });
  const payload = queued.body.operations[0].payload;
  assert.deepEqual(payload.point, point);
  assert.equal(queued.body.idempotency_key, UUID);
  assert.equal(queued.scope, 'tenant-agro-01:field-worker-01');
  assert.equal(queued.evidence, undefined);
  assert.equal(queued.accuracyMeters, undefined);
  assert.equal(queued.location, undefined);
  assert.equal(payload.accuracyMeters, undefined);
  assert.deepEqual(validateObservationPoint(point), point);
  // Deterministic serialization matters for server-side idempotency hashing.
  assert.equal(JSON.stringify(queued.body), JSON.stringify(make({ ...values, point }).body));
  assert.deepEqual(point.coordinates, [-57.9521, -34.9205]);
});

test('without permission, location is completely omitted rather than replaced with a farm centroid', () => {
  const payload = make(values).body.operations[0].payload;
  assert.equal(Object.hasOwn(payload, 'point'), false);
  assert.deepEqual(Object.keys(payload).sort(), [
    'scouting_run_id', 'observation_type', 'severity', 'notes', 'observed_at'
  ].sort());
});

test('invalid or spoofed points are rejected before IndexedDB is written', () => {
  for (const point of [null, {}, { type: 'Point', coordinates: [-190, -34] },
    { type: 'Point', coordinates: [-57, '34'] },
    { type: 'Point', coordinates: [-57, -34, 8] },
    { type: 'Point', coordinates: [-57, -34], accuracy: 1 }]) {
    assert.throws(() => make({ ...values, point }), /WGS84/);
  }
});

test('UI requires explicit GPS click; no watchPosition or automatic location upload', () => {
  const picker = readFileSync(new URL('../src/components/ObservationLocationPicker.jsx', import.meta.url), 'utf8');
  const form = readFileSync(new URL('../src/components/ObservationFormModal.jsx', import.meta.url), 'utf8');
  assert.match(picker, /onClick=\{requestLocation\}/);
  assert.match(picker, /navigator\.geolocation\.getCurrentPosition/);
  assert.doesNotMatch(picker, /watchPosition\s*\(/);
  assert.match(picker, /onChange\(null\)/);
  assert.match(picker, /requestId\.current !== current/);
  assert.match(picker, /onBusyChange\?\.\(false\)/);
  assert.match(form, /selectedLocation \? \{ point: selectedLocation\.point \} : \{\}/);
  assert.match(form, /disabled=\{saving \|\| locating \|\| savedLocally\}/);
  assert.match(form, /key=\{locationKey\}/);
});

test('closing form or switching tenant/run clears private GPS, photos and notes', () => {
  const form = readFileSync(new URL('../src/components/ObservationFormModal.jsx', import.meta.url), 'utf8');
  assert.match(form, /setForm\(emptyObservation\(\)\)/);
  assert.match(form, /setLocation\(null\)/);
  assert.match(form, /setPhoto\(null\)/);
  assert.match(form, /\[isOpen, locationKey\]/);
  assert.match(form, /location\?\.key === locationKey \? location\.fix : null/);
});
