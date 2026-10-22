import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMobileCaptureFence, createMobileCaptureSubmitGate } from '../src/services/mobileCaptureSafety.js';

test('photo preparation tickets cannot cross tenant, run, modal closure or unmount', () => {
  const fence = createMobileCaptureFence();
  fence.setScope('live:tenant-A:user-A:run-A');
  const pending = fence.ticket();
  assert.equal(fence.isCurrent(pending), true);
  fence.setScope('live:tenant-B:user-B:run-A');
  assert.equal(fence.isCurrent(pending), false);
  const other = fence.ticket();
  fence.setScope('live:tenant-B:user-B:run-B');
  assert.equal(fence.isCurrent(other), false);
  const current = fence.ticket();
  fence.invalidate();
  assert.equal(fence.isCurrent(current), false);
  assert.equal(fence.isCurrent(fence.ticket()), false);
  assert.equal(fence.isCurrent(null), false);
});

test('fence remains stable while the same authenticated form rerenders', () => {
  const fence = createMobileCaptureFence('live:tenant-A:user-A:run-A');
  const ticket = fence.ticket();
  fence.setScope('live:tenant-A:user-A:run-A');
  assert.equal(fence.isCurrent(ticket), true);
  assert.equal(Object.keys(ticket).sort().join(','), 'generation,scope');
});

test('two synchronous observation submits acquire only one durable save ticket', () => {
  const fence = createMobileCaptureFence('tenant-A:user-A:run-A');
  const gate = createMobileCaptureSubmitGate();
  const one = fence.ticket();
  const two = fence.ticket();
  assert.equal(gate.acquire(one), true);
  assert.equal(gate.acquire(two), false, 'same render may dispatch a second submit');
  assert.equal(gate.isHeld(one), true);
  assert.equal(gate.settle(one, true), true, 'durable save holds lock until modal reset');
  assert.equal(gate.acquire(two), false, 'success cannot be queued twice before modal closes');
  gate.reset();
  assert.equal(gate.acquire(two), true, 'a new modal session may save a new capture');
});

test('save failure unlocks a retry, but an obsolete completion cannot release new capture', () => {
  const fence = createMobileCaptureFence('tenant-A:user-A:run-A');
  const gate = createMobileCaptureSubmitGate();
  const first = fence.ticket();
  assert.equal(gate.acquire(first), true);
  assert.equal(gate.settle(first, false), true);
  const retry = fence.ticket();
  assert.equal(gate.acquire(retry), true);
  gate.reset();
  fence.setScope('tenant-B:user-B:run-B');
  const other = fence.ticket();
  assert.equal(gate.acquire(other), true);
  assert.equal(gate.settle(retry, false), false, 'late rejected save cannot unlock another actor');
  assert.equal(gate.settle(first, true), false, 'late success cannot make new modal sticky');
  assert.equal(gate.isHeld(other), true);
  assert.equal(gate.settle(other, false), true);
  assert.equal(gate.acquire(fence.ticket()), true);
  gate.reset();
  fence.invalidate();
  assert.equal(gate.acquire(fence.ticket()), false, 'unscoped tickets never lock the form');
});

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const photo = source('../src/services/offlinePhoto.js');
const picker = source('../src/components/ObservationLocationPicker.jsx');
const form = source('../src/components/ObservationFormModal.jsx');
const browser = source('offlineBrowser.mjs');
const acceptance = source('../../scripts/acceptance-browser-evidence-history.mjs');

test('mobile image fallback never copies original EXIF-containing bytes', () => {
  assert.match(photo, /export async function decodeMobilePhoto/);
  assert.match(photo, /new ImageConstructor\(\)/);
  assert.match(photo, /objectUrls\.revokeObjectURL\(objectUrl\)/);
  assert.match(photo, /context\.drawImage\(decoded\.image/);
  assert.match(photo, /canvas\.toBlob/);
  assert.match(photo, /validateOfflinePhoto/);
  assert.doesNotMatch(photo, /output\s*=\s*file\s*;/);
});

test('all three field image selectors allow native HEIC input without weakening output privacy', () => {
  const observation = source('../src/components/ObservationFormModal.jsx');
  const scouting = source('../src/components/EvidenceUploadModal.jsx');
  const execution = source('../src/components/WorkOrderExecutionEvidence.jsx');
  const upload = source('../src/services/privateEvidenceUpload.js');
  const inputs = [observation, scouting, execution];
  for (const ui of inputs) {
    assert.match(ui, /accept="[^"]*image\/heic,image\/heif/);
    assert.match(ui, /12 MiB/);
    assert.doesNotMatch(ui, /readAsDataURL\(photo\)|readAsDataURL\(file\)/);
  }
  assert.match(upload, /CAMERA_SOURCE_MIME_TYPES\.includes\(file\?\.type\)/);
  assert.match(upload, /converted\?\.sanitized !== true/);
  assert.match(upload, /converted\?\.mime_type !== 'image\/jpeg'/);
  assert.match(photo, /OFFLINE_PHOTO_MIME_TYPES = Object\.freeze/);
  assert.match(photo, /CAMERA_SOURCE_MIME_TYPES = Object\.freeze/);
  assert.match(photo, /mime_type: 'image\/jpeg'/);
});

test('visibility and pagehide abandon pending GPS without watchPosition', () => {
  assert.match(picker, /document\.addEventListener\('visibilitychange', onVisibility\)/);
  assert.match(picker, /window\.addEventListener\('pagehide', stopPending\)/);
  assert.match(picker, /requestId\.current \+= 1/);
  assert.match(picker, /callbacksRef\.current\.onChange\(null\)/);
  assert.doesNotMatch(picker, /watchPosition\s*\(/);
});

test('form refuses stale asynchronous photo completion and old tenant callbacks', () => {
  assert.match(form, /captureFence\.current\.setScope\(isOpen && dataMode === 'live' \? locationKey : null\)/);
  assert.match(form, /if \(!captureFence\.current\.isCurrent\(ticket\)\) return/);
  assert.match(form, /if \(captureFence\.current\.isCurrent\(ticket\)\) onQueued\?\.\(item\)/);
  assert.match(form, /submitGate\.current\.acquire\(ticket\)/);
  assert.match(form, /submitGate\.current\.settle\(ticket, stored\)/);
  assert.match(form, /submitGate\.current\.reset\(\)/);
  assert.match(form, /const stored = await offlineQueue\.queueObservation/);

});

test('Chromium exercises actual image fallback, encrypted reload and delayed location event', () => {
  assert.match(browser, /PASS: simulated mobile WebKit fallback sanitized a fresh JPEG without createImageBitmap/);
  assert.match(browser, /PASS: mobile fallback photo persisted encrypted and reopened on reload/);
  assert.match(acceptance, /PASS: hidden-tab GPS callback did not resurrect optional coordinates/);
});
