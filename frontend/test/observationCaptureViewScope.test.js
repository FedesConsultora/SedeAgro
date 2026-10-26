import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  observationCaptureViewScope, visibleObservationCapture
} from '../src/services/observationCaptureViewScope.js';

const session = {
  authenticated: true,
  tenant: { id: 'tenant-A' }, user: { id: 'actor-A' },
  membership: { id: 'membership-A', roleCode: 'scout' },
  entitlements: ['scouting', 'gis']
};

test('capture scope must change for run, tenant, actor, membership, role and entitlement', () => {
  const scope = observationCaptureViewScope(session, 'live', 'run-1');
  assert.ok(scope);
  assert.equal(observationCaptureViewScope({
    ...session, entitlements: ['gis', 'scouting', 'gis']
  }, 'live', 'run-1'), scope);
  assert.notEqual(observationCaptureViewScope(session, 'live', 'run-2'), scope);
  for (const patch of [
    { tenant: { id: 'tenant-B' } }, { user: { id: 'actor-B' } },
    { membership: { id: 'membership-B', roleCode: 'scout' } },
    { membership: { id: 'membership-A', roleCode: 'tenant_admin' } },
    { entitlements: ['scouting'] }
  ]) assert.notEqual(observationCaptureViewScope({ ...session, ...patch }, 'live', 'run-1'), scope);
});

test('unverified account, missing membership or removed scouting permission hides private capture', () => {
  for (const patch of [
    { authenticated: false }, { tenant: {} }, { user: {} }, { membership: null },
    { membership: { roleCode: 'scout' } }, { entitlements: null },
    { entitlements: ['org'] }
  ]) assert.equal(observationCaptureViewScope({ ...session, ...patch }, 'live', 'run-1'), null);
  assert.equal(observationCaptureViewScope(session, 'live', ''), null);
  assert.equal(observationCaptureViewScope(session, 'other', 'run-1'), null);
  assert.equal(observationCaptureViewScope(session, 'mock', 'run-1'),
    JSON.stringify(['demo', 'run-1']));
});

test('same private note/photo render only for the exact live capture scope', () => {
  const scope = observationCaptureViewScope(session, 'live', 'run-1');
  const original = { notes: 'Sector sur: pulgones', photo: { name: 'sur.jpg' } };
  const snapshot = { scope, value: original };
  assert.equal(visibleObservationCapture(snapshot, scope), original);
  assert.equal(visibleObservationCapture(snapshot, null), null);
  assert.equal(visibleObservationCapture(snapshot, scope + '-old'), null);
  assert.equal(visibleObservationCapture(null, scope), null);
});

test('form binds notes, photo bytes and image preview to the current scope before effects', () => {
  const source = readFileSync(new URL('../src/components/ObservationFormModal.jsx', import.meta.url), 'utf8');
  assert.match(source, /observationCaptureViewScope\(session, dataMode, runId\)/);
  assert.match(source, /visibleObservationCapture\(formSnapshot, locationKey\)/);
  assert.match(source, /visibleObservationCapture\(photoSnapshot, locationKey\)/);
  assert.match(source, /visibleObservationCapture\(photoPreviewSnapshot, locationKey\)/);
  assert.match(source, /setFormSnapshot\(\{ scope: locationKey, value: emptyObservation\(\) \}\)/);
  assert.match(source, /setPhotoSnapshot\(\{ scope: locationKey, value: selected \}\)/);
  assert.match(source, /setPhotoPreviewSnapshot\(\{ scope: locationKey, value: url \}\)/);
  assert.match(source, /captureFence\.current\.isCurrent\(ticket\)/);
  assert.match(source, /await offlineQueue\.queueObservation/);
});
