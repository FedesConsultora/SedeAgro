import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
const detail = read('pages/ScoutingPage.jsx');
const panel = read('components/RunSyncHistory.jsx');
const service = read('services/runPersonalSyncHistory.js');
const api = read('services/offlineReconciliation.js');

test('history only mounts below a loaded, authorized live scouting run detail', () => {
  assert.match(detail, /dataMode === 'live' && !loading && !error && details && \(\s*<RunSyncHistory runId=\{details\.id\}/);
  assert.match(detail, /parseScoutingRunDetail\(response, run\.id, session\?\.tenant\?\.id\)/);
  assert.match(detail, /<RunOfflineCaptures runId=\{details\.id\}/);
  assert.match(detail, /<ScoutingObservationGeoPanel/);
  assert.doesNotMatch(panel, /api\.getScoutingRun|api\.getScoutingObservations/);
});

test('personal receipts only: no tenant-wide admin endpoint or mutation, role + account scope', () => {
  assert.match(panel, /canNavigateView\('sync', access\)/);
  assert.match(panel, /sessionScope\(session\)/);
  assert.match(panel, /api\.mySyncBatches\(\)/);
  assert.doesNotMatch(panel, /api\.syncBatches\(|api\.submit|offlineQueue\.(flush|discard|recoverPhoto|allowRetry)/);
  assert.match(panel, /currentContext\.current === contextKey/);
  assert.match(panel, /sequence\.current === requestId/);
  assert.match(service, /parseMySyncReceipts\(response, session\)/);
  assert.match(api, /row\.submitted_by !== session\.user\.id/);
});

test('browser races and offline state never display old server success or falsely empty history', () => {
  assert.match(panel, /setSnapshot\(\{ key: contextKey, phase: 'offline', data: null/);
  assert.match(panel, /window\.addEventListener\('offline', onDisconnect\)/);
  assert.match(panel, /window\.addEventListener\('online', onReconnect\)/);
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /sequence\.current \+= 1/);
  assert.match(panel, /No se puede afirmar que no existan envíos/);
  assert.match(panel, /Esto no demuestra que nunca se haya sincronizado/);
  assert.match(panel, /model\.atLimit/);
  assert.match(panel, /RUN_SYNC_HISTORY_PAGE_SIZE/);
});

test('only server operation result attributes a run; no GPS/photo or private source included', () => {
  assert.match(service, /operation\?\.result\?\.scouting_run_id !== runId/);
  assert.match(service, /batch\.status === 'processed'/);
  assert.match(service, /operation\.status === 'applied'/);
  assert.match(service, /validUuid\(operation\.result\?\.observation_id\)/);
  assert.match(service, /operationCounts\.get\(item\.operationId\)/);
  assert.match(service, /observationCounts\.get\(item\.observedIdentity\)/);
  assert.match(panel, /No demuestra que una fotografía se haya cargado/);
  assert.doesNotMatch(panel, /content_base64|\.notes|\.coordinates|<img |data:image/);
  assert.doesNotMatch(service, /\.payload|\.notes|\.coordinates|\.content_base64/);
});
