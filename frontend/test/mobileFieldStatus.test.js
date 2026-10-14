import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const topbar = read('components/Topbar.jsx');
const inbox = read('components/NotificationCenter.jsx');
const sync = read('components/FieldSyncStatus.jsx');

test('topbar uses a real inbox and scoped queue badge, not an inert bell', () => {
  assert.match(topbar, /<NotificationCenter onViewChange=\{onViewChange\} \/>/);
  assert.match(topbar, /<FieldSyncStatus onViewChange=\{onViewChange\} \/>/);
  assert.doesNotMatch(topbar, /title="Notificaciones"\s*>\s*<Bell/);
});

test('inbox never shows old tenant rows while resolving another scoped collection', () => {
  assert.match(inbox, /state\.scope === scope \? state/);
  assert.match(inbox, /requestNumber\.current === requestId && scopeRef\.current === scope/);
  assert.match(inbox, /setOpen\(false\);\s*setReadWorking\(null\);\s*setActionError\(''\)/);
  assert.match(inbox, /parseNotificationList\(response, session\)/);
});

test('inbox requires verified PATCH before marking read, and permits safe navigation only', () => {
  assert.match(inbox, /parseReadReceipt\(result, item, session\)/);
  assert.match(inbox, /notificationDestination\(item, access\)/);
  assert.match(inbox, /onViewChange\?\.\(destination\.view, \{ id: destination\.id \}\)/);
  assert.match(inbox, /readWorking === item\.id \? 'Confirmando…'/);
});

test('offline badge only summarizes local session drafts and never sends or discards them', () => {
  assert.match(sync, /sessionScope\(session\)/);
  assert.match(sync, /canNavigateView\('sync', access\)/);
  assert.match(sync, /offlineQueue\.list\(session\)/);
  assert.match(sync, /queueSummary\(rows\)/);
  assert.match(sync, /window\.addEventListener\(QUEUE_EVENT, changed\)/);
  assert.match(sync, /onViewChange\?\.\('sync'\)/);
  assert.doesNotMatch(sync, /offlineQueue\.(flush|discard|allowRetry)\(/);
});

test('local errors do not masquerade as an empty or successfully synced queue', () => {
  assert.match(sync, /state: 'error', summary: null/);
  assert.match(sync, /Cola local no disponible/);
  assert.match(sync, /Consultando pendientes/);
  assert.match(sync, /pending \? `\$\{pending\} por enviar`/);
});
