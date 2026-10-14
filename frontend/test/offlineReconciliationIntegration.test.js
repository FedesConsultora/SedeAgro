import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
const page = read('pages/SyncPage.jsx');
const panel = read('components/OfflineReconciliationPanel.jsx');
const queue = read('services/offlineQueue.js');

test('SyncPage embeds reconciliation and scopes decrypted rows to current account', () => {
  assert.match(page, /<OfflineReconciliationPanel/);
  assert.match(page, /drafts=\{scopedPending\}/);
  assert.match(page, /pending\.filter\(row => row\.scope === activeScope\)/);
  assert.match(page, /loadedServerScope === serverScope \? batches : \[\]/);
  assert.match(page, /serverRequest\.current !== requestId \|\| serverScopeRef\.current !== serverScope/);
});

test('reconciliation uses only /sync/my-batches and hides data from another account', () => {
  assert.match(panel, /api\.mySyncBatches\(\)/);
  assert.doesNotMatch(panel, /api\.syncBatches\(/);
  assert.match(panel, /snapshot\.scope === scope/);
  assert.match(panel, /drafts\.filter\(item => item\.scope === scope\)/);
  assert.match(panel, /seq\.current === requestId && scopeRef\.current === scope/);
  assert.match(panel, /scopeRef\.current !== expectedScope/);
});

test('cleanup uses fresh confirmation, explicit prompt and independent photo rule', () => {
  assert.match(panel, /window\.confirm\(/);
  assert.match(panel, /const response = await api\.mySyncBatches\(\)/);
  assert.match(panel, /reconcileOfflineDraft\(draft, matches, session\)\.status !== 'confirmed'/);
  assert.match(panel, /offlineQueue\.confirmApplied\(session, draft\.id, matches\[0\]\)/);
  assert.match(queue, /const verified = reconcileOfflineDraft\(current, \[receipt\], session\)/);
  assert.match(queue, /verified\.status !== 'confirmed' \|\| current\.evidence/);
  assert.doesNotMatch(panel, /offlineQueue\.discard|offlineQueue\.flush/);
});

test('receipt status never silently means delivery of GPS/photo', () => {
  assert.match(panel, /GPS incluido/);
  assert.match(panel, /Fotografía conservada/);
  assert.match(panel, /no reenvía datos, modifica GPS ni adjunta archivos/);
  assert.match(panel, /los 100 recibos/);
  assert.match(panel, /ausencia de un recibo no demuestra/);
});
