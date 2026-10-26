import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewQueueUrl, reviewQueueFailure, reviewQueueRequestKey,
  validateReviewQueue, isCoordinationReviewer,
  REVIEW_QUEUE_STATES, REVIEW_QUEUE_PAGE_FILTERS, filterReviewQueuePage,
  REVIEW_QUEUE_WORK_TYPES, REVIEW_QUEUE_PRIORITIES, REVIEW_QUEUE_DUE_WINDOWS,
  normalizeReviewTitleQuery, REVIEW_TITLE_QUERY_MAX_CODEPOINTS, REVIEW_QUEUE_SORT_MODES
} from '../src/services/workOrderReviewQueue.js';

const entry = { id: 'o1', title: 'Inspección', type: 'inspection', status: 'in_progress',
  state: 'human_review', reason: 'Requiere chequeo humano', report_id: 'r1' };
const paged = { data: [entry], pagination: { page_size: 50, has_more: false, next_cursor: null } };

test('real authenticated coordination only, never mock, contractor or scout', () => {
  assert.equal(isCoordinationReviewer('tenant_admin', 'live', true), true);
  assert.equal(isCoordinationReviewer('agronomic_coordinator', 'live', true), true);
  for (const role of ['contractor', 'scout', 'producer', null]) {
    assert.equal(isCoordinationReviewer(role, 'live', true), false);
  }
  assert.equal(isCoordinationReviewer('tenant_admin', 'mock', true), false);
  assert.equal(isCoordinationReviewer('tenant_admin', 'live', false), false);
});

test('server-authored cursor and bounded page are validated without local offset guesses', () => {
  const opaque = 'x'.repeat(60) + '.' + 'Y'.repeat(43);
  assert.equal(reviewQueueUrl(), '/work-orders/review-queue');
  assert.equal(reviewQueueUrl('a.b+/'), '/work-orders/review-queue?cursor=a.b%2B%2F');
  assert.deepEqual(validateReviewQueue(paged),
    { items: [entry], hasMore: false, nextCursor: null });
  assert.deepEqual(validateReviewQueue({ data: [], pagination: {
    page_size: 50, has_more: true, next_cursor: opaque } }),
  { items: [], hasMore: true, nextCursor: opaque });
  assert.throws(() => validateReviewQueue({ data: [], pagination: {
    page_size: 50, has_more: true, next_cursor: null } }), /no es válida/);
  assert.throws(() => validateReviewQueue({ data: [], pagination: {
    page_size: 50, has_more: false, next_cursor: opaque } }), /no es válida/);
  assert.throws(() => validateReviewQueue({ ...paged, data: [{
    ...entry, state: 'automatically_verified' }] }), /no es válida/);
  assert.throws(() => validateReviewQueue({ ...paged, data: [{
    ...entry, status: 'completed' }] }), /no es válida/);
  assert.throws(() => validateReviewQueue({ ...paged, data: [{
    ...entry, reason: undefined }] }), /no es válida/);
  assert.throws(() => validateReviewQueue({ ...paged, data: Array.from({
    length: 51 }, () => entry) }), /no es válida/);
});

test('inbox surfaces failure, clears previous data and opens authorized details only', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/pages/WorkOrdersPage.jsx', import.meta.url), 'utf8');
  assert.match(ui, /reviewQueueUrl/);
  assert.match(ui, /let active = true/);
  assert.match(ui, /requestState\?\.key === requestKey/);
  assert.match(ui, /setRequestState/);
  assert.match(ui, /if \(active\) setRequestState/);
  assert.match(ui, /const controller = new AbortController/);
  assert.match(ui, /controller\.abort\(\)/);
  assert.match(ui, /reviewQueueFailure\(err, cursor !== null\)/);
  assert.match(ui, /Iniciar nueva consulta/);
  assert.match(ui, /ref=\{errorActionRef\}/);
  assert.match(ui, /headingRef\.current\?\.focus\(\)/);
  assert.match(ui, /aria-busy=\{loading\}/);
  assert.match(ui, /aria-live="polite"/);
  assert.match(ui, /tabIndex=\{-1\}/);
  assert.match(ui, /aria-label="Página anterior de pendientes"/);
  assert.match(ui, /tenantId, userId/);
  assert.match(ui, /setCursors/);
  assert.match(ui, /WorkOrderReviewInboxSession key/);
  assert.match(ui, /onOpenOrder\(\{ id: item.id, title: item.title \}\)/);
  const inboxRead = ui.slice(ui.indexOf('api.request(reviewQueueUrl('),
    ui.indexOf('.then(result =>', ui.indexOf('api.request(reviewQueueUrl(')));
  assert.doesNotMatch(inboxRead, /method:\s*['"](?:POST|PATCH)/,
    'The inbox query remains read-only even when saved views use POST');
  assert.doesNotMatch(ui, /approve\(/);
  // Opening an inbox result must carry the exact current actor/API scope.
  assert.match(page, /<WorkOrderReviewInbox key=\\{scope\\} revision=\\{revision\\} onOpenOrder=\\{selectOrder\\}/);
  assert.match(page, /const selectOrder = \\(order\\) => setSelectedSnapshot\\(\\{ scope, api, revision, order \\}\\)/);
});

test('expired or transferred cursor produces a restart action, never repeated with same signed token', () => {
  const failure = reviewQueueFailure({
    status: 422, code: 'ORDER_REVIEW_CURSOR_INVALID', message: 'Cursor inválido'
  }, true);
  assert.equal(failure.expired, true);
  assert.match(failure.message, /consulta nueva/);
  assert.doesNotMatch(failure.message, /Cursor inválido/);
  assert.equal(reviewQueueFailure({
    status: 422, code: 'ORDER_REVIEW_CURSOR_INVALID'
  }, false).expired, false,
  'An invalid first-page payload must not be treated as an expired pagination cursor');
  assert.equal(reviewQueueFailure({ status: 403, code: 'ORDER_REVIEW_CURSOR_INVALID',
    message: 'Acceso denegado' }, true).expired, false,
  'Role revocation must not be confused with cursor expiration');
});

test('network errors are retryable and never treated as valid empty inbox', () => {
  const failure = reviewQueueFailure({ status: 0, code: 'NETWORK_ERROR' }, true);
  assert.equal(failure.expired, false);
  assert.match(failure.message, /No se pudo/);
  assert.equal(reviewQueueFailure(new Error('Servidor temporalmente inaccesible'), true).expired, false);
});

test('page, cursor and retry generation fence asynchronous responses', () => {
  const first = reviewQueueRequestKey(0, null, 0);
  const second = reviewQueueRequestKey(1, 'signed.token', 0);
  const retried = reviewQueueRequestKey(1, 'signed.token', 1);
  assert.notEqual(first, second);
  assert.notEqual(second, retried);
  assert.equal(reviewQueueRequestKey(0, null, 0), first);
  assert.throws(() => reviewQueueRequestKey(-1, null, 0), /inválida/);
  assert.throws(() => reviewQueueRequestKey(0, { bogus: true }, 0), /inválida/);
  assert.throws(() => reviewQueueRequestKey(0, null, NaN), /inválida/);
});

test('page-only categories cover every server state without inventing global counts', () => {
  const records = Object.keys(REVIEW_QUEUE_STATES).map((state, i) => ({
    ...entry, id: String(i), state
  }));
  const groups = Object.keys(REVIEW_QUEUE_PAGE_FILTERS);
  assert.deepEqual(groups, ['all', 'no_report', 'blocked', 'review', 'closure']);
  assert.equal(filterReviewQueuePage(records).length, 8);
  assert.equal(filterReviewQueuePage(records, 'no_report').length, 1);
  assert.equal(filterReviewQueuePage(records, 'blocked').length, 5);
  assert.equal(filterReviewQueuePage(records, 'review').length, 1);
  assert.equal(filterReviewQueuePage(records, 'closure').length, 1);
  assert.equal(filterReviewQueuePage(records, 'all'), records);
  assert.equal(records.length, 8, 'filter must not mutate a server page');
  assert.deepEqual(filterReviewQueuePage([], 'blocked'), []);
  assert.throws(() => filterReviewQueuePage(records, 'all-tenants'), /inválido/);
  assert.throws(() => filterReviewQueuePage(null, 'all'), /inválido/);
});

test('state filter now queries the server before pagination instead of slicing loaded page', () => {
  const component = readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx', import.meta.url), 'utf8');
  for (const contract of [
    'reviewQueueUrl(cursor, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'reviewQueueRequestKey(page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'aria-pressed={reviewState === key}',
    'changeReviewState(key)', 'items.map(', 'Estado de revisión (todas las páginas)',
    'setCursors([null])'
  ]) assert.ok(component.includes(contract), 'Missing server review state filter: '+contract);
  assert.ok(!component.includes('filterReviewQueuePage(items, filter)'));
  assert.ok(!component.includes('El filtro no busca en otras páginas'));
  assert.ok(!component.includes('visibleItems.map('));
});

test('global SQL work-type query is distinct from the current-page state filter', () => {
  const keys = Object.keys(REVIEW_QUEUE_WORK_TYPES);
  assert.deepEqual(keys, ['all', 'application', 'sowing', 'fertilization',
    'harvest', 'irrigation', 'inspection', 'other']);
  assert.equal(reviewQueueUrl(null, 'all'), '/work-orders/review-queue');
  assert.equal(reviewQueueUrl(null, 'application'),
    '/work-orders/review-queue?type=application');
  assert.equal(reviewQueueUrl('a.b+/', 'application'),
    '/work-orders/review-queue?cursor=a.b%2B%2F&type=application');
  assert.throws(() => reviewQueueUrl(null, 'other-company'), /inválido/);
  const all = reviewQueueRequestKey(0, null, 0);
  const typed = reviewQueueRequestKey(0, null, 0, 'application');
  assert.notEqual(all, typed, 'Type change must fence previous async responses');
  assert.notEqual(reviewQueueRequestKey(1, 'signed', 0, 'application'),
    reviewQueueRequestKey(1, 'signed', 0, 'inspection'),
    'Signed cursor must be request-bound to selected work type');
  assert.throws(() => reviewQueueRequestKey(0, null, 0, 'bad'), /inválida/);
});

test('global selector resets signed cursors, page-local state and old response generation', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx', import.meta.url), 'utf8');
  for (const expected of [
    'Tipo de labor (todas las páginas)',
    'reviewQueueRequestKey(page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'reviewQueueUrl(cursor, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'setWorkType(nextType)', 'setCursors([null])', 'setPage(0)',
    "setReviewState('all')", 'REVIEW_QUEUE_WORK_TYPES'
  ]) assert.ok(ui.includes(expected), 'Global SQL filter contract missing: ' + expected);
  assert.ok(ui.includes('disabled={loading}'), 'Selector should not act during in-flight queries');
  assert.ok(ui.includes('onChange={event => changeWorkType(event.target.value)}'));
});

test('global state scope prevents cross-filter response/cursor reuse', () => {
  assert.equal(reviewQueueUrl(null, 'all', 'no_report'),
    '/work-orders/review-queue?state=no_report');
  assert.equal(reviewQueueUrl('abc.def', 'application', 'closure'),
    '/work-orders/review-queue?cursor=abc.def&type=application&state=closure');
  assert.throws(() => reviewQueueUrl(null, 'all', 'bogus'), /inválido/);
  assert.notEqual(reviewQueueRequestKey(1,'cursor',2,'application','no_report'),
    reviewQueueRequestKey(1,'cursor',2,'application','closure'));
  assert.throws(() => reviewQueueRequestKey(0,null,0,'all','bad'), /inválida/);
});

test('priority is a SQL-global filter and is part of every request generation', () => {
  assert.deepEqual(Object.keys(REVIEW_QUEUE_PRIORITIES),
    ['all', 'urgent', 'high', 'normal', 'low']);
  assert.equal(reviewQueueUrl(null,'all','all','all'), '/work-orders/review-queue');
  assert.equal(reviewQueueUrl(null,'all','all','urgent'),
    '/work-orders/review-queue?priority=urgent');
  assert.equal(reviewQueueUrl('a.b','application','blocked','normal'),
    '/work-orders/review-queue?cursor=a.b&type=application&state=blocked&priority=normal');
  assert.throws(()=>reviewQueueUrl(null,'all','all','critical'),/inválido/);
  assert.notEqual(
    reviewQueueRequestKey(1,'signed',0,'inspection','no_report','normal'),
    reviewQueueRequestKey(1,'signed',0,'inspection','no_report','urgent')
  );
  assert.throws(()=>reviewQueueRequestKey(0,null,0,'all','all','critical'),/inválida/);
});

test('priority selector is accessible, global and resets cursors without dropping work type/state', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx', import.meta.url),'utf8');
  for (const phrase of [
    'Prioridad (todas las páginas)', 'review-queue-priority',
    'REVIEW_QUEUE_PRIORITIES', 'changePriority(event.target.value)',
    'setPriority(nextPriority)', 'setCursors([null])', 'setPage(0)',
    'reviewQueueUrl(cursor, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'reviewQueueRequestKey(page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode)'
  ]) assert.ok(ui.includes(phrase), 'Missing global priority UI contract: '+phrase);
  const fn = ui.slice(ui.indexOf('const changePriority ='),ui.indexOf('const changeWorkType ='));
  assert.ok(!fn.includes("setWorkType("));
  assert.ok(!fn.includes("setReviewState("));
  assert.ok(fn.includes("setPriority(nextPriority)"));
  assert.ok(ui.includes('value={priority} disabled={loading}'));
});

test('global due-window URL and request generations are isolated across filters', () => {
  assert.deepEqual(Object.keys(REVIEW_QUEUE_DUE_WINDOWS),
    ['all','overdue','next_7_days','later','unscheduled']);
  assert.equal(reviewQueueUrl(), '/work-orders/review-queue');
  assert.equal(reviewQueueUrl(null,'all','all','all','overdue'),
    '/work-orders/review-queue?due=overdue');
  assert.equal(reviewQueueUrl('a.b+/','application','blocked','urgent','next_7_days'),
    '/work-orders/review-queue?cursor=a.b%2B%2F&type=application&state=blocked&priority=urgent&due=next_7_days');
  assert.throws(()=>reviewQueueUrl(null,'all','all','all','next-month'),/inválido/);
  assert.notEqual(
    reviewQueueRequestKey(1,'cursor',0,'application','blocked','urgent','overdue'),
    reviewQueueRequestKey(1,'cursor',0,'application','blocked','urgent','next_7_days')
  );
  assert.throws(()=>reviewQueueRequestKey(0,null,0,'all','all','all','invalid'),/inválida/);
});

test('accessible due selector starts a new cursor while retaining type/state/priority', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx', import.meta.url),'utf8');
  for (const value of [
    'Vencimiento (todas las páginas)', 'review-queue-due-window',
    'REVIEW_QUEUE_DUE_WINDOWS', 'changeDueWindow(event.target.value)',
    'setDueWindow(nextWindow)','setPage(0)','setCursors([null])',
    'reviewQueueUrl(cursor, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'reviewQueueRequestKey(page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode)'
  ]) assert.ok(ui.includes(value),'Due-window UI contract missing '+value);
  const only = ui.slice(ui.indexOf('const changeDueWindow ='),ui.indexOf('const changePriority ='));
  assert.ok(!only.includes('setWorkType('));
  assert.ok(!only.includes('setReviewState('));
  assert.ok(!only.includes('setPriority('));
  assert.ok(only.includes('setReload(value => value + 1)'));
  assert.ok(ui.includes('value={dueWindow} disabled={loading}'));
});

test('global title search encodes a literal bounded Unicode phrase in URL and request key', () => {
  assert.equal(REVIEW_TITLE_QUERY_MAX_CODEPOINTS,64);
  assert.equal(normalizeReviewTitleQuery('  Riego   URGENTE '),'Riego URGENTE');
  assert.equal(normalizeReviewTitleQuery('Cafe\u0301'),'Café');
  assert.equal(reviewQueueUrl(),'/work-orders/review-queue');
  assert.equal(reviewQueueUrl(null,'all','all','all','all','Café'),
    '/work-orders/review-queue?q=Caf%C3%A9');
  assert.equal(reviewQueueUrl('signed.token','inspection','no_report','normal',
    'overdue','Riego %_'),
    '/work-orders/review-queue?cursor=signed.token&type=inspection&state=no_report&priority=normal&due=overdue&q=Riego+%25_');
  assert.notEqual(reviewQueueRequestKey(1,'signed',0,'all','all','all','all','Camino'),
    reviewQueueRequestKey(1,'signed',0,'all','all','all','all','Cosecha'));
  for (const invalid of ['a','a'.repeat(65),' No canon ','Riego\u200B']) {
    assert.throws(()=>reviewQueueUrl(null,'all','all','all','all',invalid),/inválido/);
    assert.throws(()=>reviewQueueRequestKey(0,null,0,'all','all','all','all',invalid),/inválida/);
  }
});

test('title search form applies only submitted phrases and resets signed cursor', () => {
  const source=readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx',import.meta.url),'utf8');
  for (const required of [
    'role="search"', 'Buscar por título (todas las páginas)', 'review-queue-title-search',
    'submitTitleSearch', 'normalizeReviewTitleQuery(draftTitle)',
    'const commitTitleQuery = value =>', 'setTitleQuery(value)', 'setCursors([null])',
    'Búsqueda activa por título:', 'Limpiar búsqueda',
    'reviewQueueUrl(cursor, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'reviewQueueRequestKey(page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode)'
  ]) assert.ok(source.includes(required), 'Missing global title search contract: '+required);
  assert.ok(source.includes('event.preventDefault()'));
  assert.ok(source.includes("setTitleError('Escribí entre 2 y 64 caracteres"));
  assert.ok(source.includes('maxLength={64} disabled={loading}'));
  const searchFn=source.slice(source.indexOf('const commitTitleQuery ='),
    source.indexOf('const saveView ='));
  assert.ok(!searchFn.includes('setWorkType('));
  assert.ok(!searchFn.includes('setPriority('));
  assert.ok(!searchFn.includes('setDueWindow('));
  assert.ok(!searchFn.includes('setReviewState('));
});

test('operational sort is server-wide, validates enum and fences old responses', () => {
  assert.deepEqual(Object.keys(REVIEW_QUEUE_SORT_MODES),
    ['newest','due_first','priority_first']);
  assert.equal(reviewQueueUrl(), '/work-orders/review-queue');
  assert.equal(reviewQueueUrl(null,'all','all','all','all','','due_first'),
    '/work-orders/review-queue?sort=due_first');
  assert.equal(reviewQueueUrl('signed','inspection','no_report','urgent','overdue',
    'Control de campo','priority_first'),
    '/work-orders/review-queue?cursor=signed&type=inspection&state=no_report&priority=urgent&due=overdue&q=Control+de+campo&sort=priority_first');
  assert.throws(()=>reviewQueueUrl(null,'all','all','all','all','','random'),/inválido/);
  assert.notEqual(
    reviewQueueRequestKey(1,'cursor',0,'all','all','all','all','','newest'),
    reviewQueueRequestKey(1,'cursor',0,'all','all','all','all','','due_first'));
  assert.throws(()=>reviewQueueRequestKey(0,null,0,'all','all','all','all','','missing'),/inválida/);
});

test('operational sort selector resets cursor and keeps all global filter criteria', () => {
  const source=readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx',import.meta.url),'utf8');
  for (const value of [
    'Ordenar resultados (todas las páginas)','review-queue-sort',
    'REVIEW_QUEUE_SORT_MODES','changeSortMode(event.target.value)',
    'setSortMode(nextSort)','setPage(0)','setCursors([null])',
    'reviewQueueUrl(cursor, workType, reviewState, priority, dueWindow, titleQuery, sortMode)',
    'reviewQueueRequestKey(page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode)'
  ]) assert.ok(source.includes(value),'Sort UI missing '+value);
  const method=source.slice(source.indexOf('const changeSortMode ='),
    source.indexOf('const changeDueWindow ='));
  assert.ok(!method.includes('setWorkType('));
  assert.ok(!method.includes('setReviewState('));
  assert.ok(!method.includes('setPriority('));
  assert.ok(!method.includes('setDueWindow('));
  assert.ok(!method.includes('setTitleQuery('));
  assert.ok(source.includes('value={sortMode} disabled={loading}'));
});

test('saved view UI never retains or restores cursor, and is identity remounted', () => {
  const component=readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx',import.meta.url),'utf8');
  for(const marker of [
    'Mis vistas guardadas','Guardar filtros actuales','Elegir vista guardada',
    'Aplicar vista','Eliminar vista…','Confirmar eliminación',
    'REVIEW_VIEWS_PATH','validateSavedViews(response)','validateSavedView(await api.request',
    'reviewViewFilters(selected.filters)','setWorkType(filters.workType)',
    'setReviewState(filters.reviewState)','setPriority(filters.priority)',
    'setDueWindow(filters.dueWindow)','setTitleQuery(filters.titleQuery)',
    'setSortMode(filters.sortMode)','setPage(0)','setCursors([null])',
    'WorkOrderReviewInboxSession key={identity}'
  ]) assert.ok(component.includes(marker),'Missing saved-view integration: '+marker);
  const apply=component.slice(component.indexOf('const applyView ='),
    component.indexOf('const removeView ='));
  assert.ok(!apply.includes('setCursors(previous =>'), 'Never replay saved cursor');
  assert.ok(component.includes('setDeleteArmed(true)'));
  assert.ok(component.includes('controller.abort()'));
});

test('shared view UI limits private writes and exposes admin-only visibility toggle',()=>{
  const source=readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx',import.meta.url),'utf8');
  for(const token of [
    "view.source === 'mine'", "view.source === 'shared'",
    "selectedView?.source === 'mine'", "role === 'tenant_admin'",
    "changeViewVisibility('shared')", "changeViewVisibility('private')",
    "Compartir con coordinación", "Dejar de compartir",
    "Compartidas con coordinación", "Esta vista es de solo lectura",
    "if (viewBusy || viewLoading || !deleteArmed || !selectedViewId || !canManageSelected)",
    "setCursors([null])", "setPage(0)"
  ]) assert.ok(source.includes(token),'Missing view-share safety: '+token);
  assert.ok(!source.includes("localStorage"));
});

test('admin moderation is role restricted, two-stage and never edits the author filter',()=>{
  const source=readFileSync(new URL('../src/components/WorkOrderReviewInbox.jsx',import.meta.url),'utf8');
  for(const marker of [
    "role === 'tenant_admin' && <section",
    "REVIEW_MODERATION_PATH",
    "validateModerationInventory", "validateModerationAudit",
    "normalizeModerationReason(moderationReason)",
    "setModerationArmed(true)", "setModerationArmed(false)",
    "Confirmar revocación", "Cancelar revocación",
    "Historial de revocaciones (últimas 50)",
    "method:'POST',silent:true,body:{reason}",
    "setSavedViews(previous=>previous.filter(view=>view.id!==moderationTargetId))",
    "setModerationRevision(previous=>previous+1)",
    "controller.abort()"
  ]) assert.ok(source.includes(marker), 'Moderation UI missing '+marker);
  const moderator=source.slice(source.indexOf('const chooseModeration ='),
    source.indexOf('const changeReviewState ='));
  for(const forbidden of ['setWorkType(', 'setReviewState(', 'setPriority(',
    'setDueWindow(', 'setTitleQuery(', 'setSortMode(']) {
    assert.ok(!moderator.includes(forbidden), 'Moderator cannot mutate view filters');
  }
});
