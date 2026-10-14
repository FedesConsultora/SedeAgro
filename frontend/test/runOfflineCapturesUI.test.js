import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const page = read('pages/ScoutingPage.jsx');
const app = read('App.jsx');
const panel = read('components/RunOfflineCaptures.jsx');
const service = read('services/runOfflineCaptures.js');

test('only a live authorized run detail can mount the local capture companion', () => {
  assert.match(page, /dataMode === 'live' && !loading && !error && details && \(\s*<RunOfflineCaptures/);
  assert.match(page, /runId=\{details\.id\}/);
  assert.match(page, /<ScoutingObservationGeoPanel/);
  assert.match(page, /observations=\{observations\}/);
  assert.doesNotMatch(panel, /api\.getScoutingRun\(|api\.scoutingRuns\(/);
});

test('run local view fetches encrypted queue only under the session and permission scope', () => {
  assert.match(panel, /sessionScope\(session\)/);
  assert.match(panel, /canNavigateView\('sync', access\)/);
  assert.match(panel, /offlineQueue\.list\(session\)/);
  assert.match(panel, /runLocalCaptureSummary\(rows, session, runId\)/);
  assert.match(panel, /state\.key === key \? state/);
  assert.match(panel, /!cancelled && sequence === current/);
  assert.match(panel, /window\.addEventListener\(QUEUE_EVENT, changed\)/);
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /online/);
  assert.match(panel, /offline/);
});

test('no local field record or GPS point is falsely counted as a persisted observation', () => {
  assert.match(panel, /No se puede afirmar que la cola esté vacía/);
  assert.match(panel, /No están incluidos en las observaciones confirmadas ni en el croquis/);
  assert.doesNotMatch(panel, /scoutingObservationGeography|<path |<circle|<img|data:image/);
  assert.doesNotMatch(panel, /content_base64|\.notes|\.coordinates/);
  assert.doesNotMatch(panel, /offlineQueue\.(flush|discard|allowRetry|recoverPhoto|confirmApplied)\(/);
  assert.doesNotMatch(service, /localStorage|sessionStorage|window\./);
});

test('scouting-to-sync navigation is access-checked in Shell, not a hardcoded external link', () => {
  assert.match(page, /onOpenSync=\{\(\) => onNavigate\?\.\('sync', \{ id: details\.id \}\)\}/);
  assert.match(app, /onNavigate=\{handleViewChange\}/);
  assert.match(app, /if \(!canNavigateView\(id, access\)\) return;/);
  assert.match(panel, /onOpenSync\?\.\(\)/);
  assert.doesNotMatch(panel, /window\.location|href=|fetch\(/);
});

test('local capture list reports GPS/photo as booleans and never displays decrypted notes or bytes', () => {
  assert.match(panel, /item\.hasGps &&/);
  assert.match(panel, /item\.hasPhoto &&/);
  assert.match(panel, /LOCAL_CAPTURE_PHASES\[item\.phase\]\.label/);
  assert.match(panel, /summary\.pendingObservations/);
  assert.match(panel, /summary\.pendingPhotos/);
  assert.match(panel, /summary\.review/);
  assert.match(service, /validateObservationPoint\(operation\.payload\.point\)/);
});
