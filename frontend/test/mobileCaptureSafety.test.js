import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMobileCaptureFence } from '../src/services/mobileCaptureSafety.js';

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
});

test('Chromium exercises actual image fallback, encrypted reload and delayed location event', () => {
  assert.match(browser, /PASS: simulated mobile WebKit fallback sanitized a fresh JPEG without createImageBitmap/);
  assert.match(browser, /PASS: mobile fallback photo persisted encrypted and reopened on reload/);
  assert.match(acceptance, /PASS: hidden-tab GPS callback did not resurrect optional coordinates/);
});
