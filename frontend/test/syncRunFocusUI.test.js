import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
const app = read('App.jsx');
const scouting = read('pages/ScoutingPage.jsx');
const sync = read('pages/SyncPage.jsx');
const panel = read('components/OfflineReconciliationPanel.jsx');
const model = read('services/syncRunFocus.js');

test('run detail sends only an authorized run identity using guarded Shell navigation', () => {
  assert.match(scouting, /onOpenSync=\{\(\) => onNavigate\?\.\('sync', \{ id: run\.id \}\)\}/);
  assert.doesNotMatch(scouting, /onNavigate\?\.\('sync', \{ id: details\.id \}\)/);
  assert.match(app, /focused\?\.view === 'sync' \? focused\.id : null/);
  assert.match(app, /onClearFocus=\{\(\) => handleViewChange\('sync'\)\}/);
  assert.match(app, /if \(!canNavigateView\(id, access\)\) return;/);
});

test('SyncPage focus filters local drafts, personal reconciliation and attributable server receipts', () => {
  assert.match(sync, /resolveSyncRunFocus\(focusRunId\)/);
  assert.match(sync, /filterSyncRunDrafts\(scopedPending, activeScope, focus\)/);
  assert.match(sync, /filterSyncRunReceipts\(scopedBatches, focus\)/);
  assert.match(sync, /visiblePending\.map\(\(item\) =>/);
  assert.match(sync, /visibleBatches\.map\(\(batch\) =>/);
  assert.match(sync, /drafts=\{visiblePending\}/);
  assert.match(panel, /drafts\.filter\(item => item\.scope === scope\)/);
  assert.match(model, /operation\?\.result\?\.scouting_run_id === focus\.runId/);
});

test('focused SyncPage does not silently imply selective upload or expose unrelated drafts', () => {
  assert.match(sync, /Enviar todos mis pendientes/);
  assert.match(sync, /procesa TODAS las recorridas de esta cuenta/);
  assert.match(sync, /focus\.mode === 'run' && !window\.confirm/);
  assert.match(sync, /focus\.mode === 'invalid'\) return/);
  assert.match(sync, /pendingCount === 0 \|\| focus\.mode === 'invalid'/);
  assert.match(sync, /Ver todas las recorridas/);
  assert.match(sync, /onClearFocus\?\.\(\)/);
  assert.match(sync, /No hay capturas locales que coincidan con esta recorrida/);
  assert.match(sync, /Un recibo sin identificador de recorrida no se atribuye por suposición/);
  assert.doesNotMatch(model, /localStorage|sessionStorage|window\./);
});

test('server fetch remains scoped and does not invent missing historical receipts', () => {
  assert.match(sync, /visibleSyncReceiptRows\(batches, loadedServerScope, loadedServerApi, serverScope, api\)/);
  assert.match(sync, /serverApiRef\.current === api/);
  assert.match(sync, /entre los 100 recientes/);
  assert.match(sync, /Sin recibos identificables en esta recorrida/);
  assert.match(sync, /No se muestran capturas ni recibos por una referencia inválida/);
});
