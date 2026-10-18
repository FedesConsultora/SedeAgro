import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewQueueUrl, validateReviewQueue, isCoordinationReviewer,
  REVIEW_QUEUE_STATES } from '../src/services/workOrderReviewQueue.js';

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
  assert.match(ui, /\/work-orders\/review-queue\?page=/);
  assert.match(ui, /let active = true/);
  assert.match(ui, /setResponse\(null\)/);
  assert.match(ui, /if \(active\) setResponse\(validated\)/);
  assert.match(ui, /if \(active\) setError/);
  assert.match(ui, /tenantId, userId/);\n  assert.match(ui, /setCursors\\(\\[null\\]\\)/);\n  assert.match(ui, /WorkOrderReviewInboxSession key=\\{identity\\}/);
  assert.match(ui, /onOpenOrder\(\{ id: item.id, title: item.title \}\)/);
  assert.doesNotMatch(ui, /POST|PATCH|approve\(/);
  assert.match(page, /<WorkOrderReviewInbox revision=\{revision\} onOpenOrder=\{setSelectedOrder\}/);
});
