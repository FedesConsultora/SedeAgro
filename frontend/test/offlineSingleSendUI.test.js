import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const page = read('pages/SyncPage.jsx');
const queue = read('services/offlineQueue.js');
const focus = read('services/syncRunFocus.js');

test('selected draft is drawn only from the current actor and focused run list', () => {
  assert.match(page, /filterSyncRunDrafts\(scopedPending, activeScope, focus\)/);
  assert.match(page, /!visiblePending\.some\(row => row\.id === item\.id\)/);
  assert.match(page, /item\.scope !== scope/);
  assert.match(page, /focus\.mode === 'invalid'/);
  assert.match(page, /scopeRef\.current !== scope/);
});

test('targeted actions send exactly one ID through the existing account-locked queue', () => {
  assert.match(page, /offlineQueue\.flushOne\(session, item\.id,/);
  assert.match(queue, /onlyId: id, force: true, manualReview: true, sendEvidence/);
  assert.match(queue, /const items = single\s*\? \[await store\.get\(onlyId\)\]\.filter\(Boolean\)/);
  assert.match(queue, /inFlightScopes\.has\(scope\)/);
  assert.match(queue, /withLock\(scope, async \(\) =>/);
  assert.match(page, /Enviar solo esta/);
  assert.match(page, /Reintentar solo esta/);
  assert.doesNotMatch(page, /offlineQueue\.allowRetry\(/);
});

test('explicit review is not silently reset before user approval or HTTP', () => {
  assert.match(page, /item\.state !== 'pending' && !window\.confirm/);
  assert.match(page, /Se reintentará SOLO esta captura/);
  assert.match(queue, /manualReview && \['auth', 'conflict'\]\.includes\(saved\.state\)/);
  assert.match(queue, /manualReview && \['auth', 'conflict'\]\.includes\(item\.state\)/);
});

test('already-applied observation with photo pending cannot be batch resent from selected action', () => {
  assert.match(page, /item\.evidence && item\.syncedObservationId/);
  assert.match(page, /Recuperar foto en conciliación/);
  assert.match(queue, /photoRecoveryRequired: true/);
  assert.match(queue, /if \(single && item\.evidence && item\.syncedObservationId\)/);
  assert.doesNotMatch(page, /delete\(item\.id\)/);
});

test('global send behavior remains explicit about the entire tenant queue', () => {
  assert.match(page, /Enviar todos mis pendientes/);
  assert.match(page, /procesa TODAS las recorridas de esta cuenta/);
  assert.match(page, /offlineQueue\.flush\(session,/);
  assert.match(page, /disabled=\{!online \|\| sending \|\| Boolean\(sendingOne\)/);
  assert.match(queue, /!single && !force && !isEligibleForAutoRetry/);
  assert.match(focus, /item\.body\.operations\[0\]\?\.payload\?\.scouting_run_id === focus\.runId/);
});

test('failure or a competing tab never appears to be a completed upload', () => {
  assert.match(page, /result\.skipped\) setNotice\('Otra pestaña/);
  assert.match(page, /result\.sent === 1\) setNotice\('Esta captura se confirmó/);
  assert.match(page, /result\.attempted === 1\) setNotice\(/);
  assert.match(page, /La captura permanece para reintentar/);
  assert.match(page, /result\.invalidDraft\) setLocalError\(/);
  assert.match(page, /disabled=\{sending \|\| Boolean\(sendingOne\)\}/);
});
