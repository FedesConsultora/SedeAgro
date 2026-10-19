import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewQueueUrl, reviewQueueFailure, reviewQueueRequestKey,
  validateReviewQueue, isCoordinationReviewer,
  REVIEW_QUEUE_STATES, REVIEW_QUEUE_PAGE_FILTERS, filterReviewQueuePage
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
  assert.doesNotMatch(ui, /POST|PATCH|approve\(/);
  assert.match(page, /<WorkOrderReviewInbox revision=\{revision\} onOpenOrder=\{setSelectedOrder\}/);
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
