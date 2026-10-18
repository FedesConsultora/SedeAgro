import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReviewQueueItem, REVIEW_QUEUE_PAGE_SIZE,
  REVIEW_QUEUE_STATES, selectReviewQueueReports } from '../src/modules/workOrders/reviewQueuePolicy.js';

const order = { id: 'o', title: 'Revisión lote', type: 'inspection',
  priority: 'normal', due_at: null, status: 'in_progress' };
const report = { id: 'r', review_status: 'submitted', submitted_by: 'operator',
  input_declaration: null };
const args = { order, report, plannedInputCount: 0, exceptions: [],
  evidenceCount: 0, reviewerId: 'admin' };
const state = input => classifyReviewQueueItem({ ...args, ...input }).state;

test('never reports automatic acceptance; human review remains independently required', () => {
  assert.equal(REVIEW_QUEUE_PAGE_SIZE, 50);
  assert.equal(REVIEW_QUEUE_STATES.length, 8);
  const item = classifyReviewQueueItem(args);
  assert.equal(item.state, 'human_review');
  assert.match(item.reason, /checklist|integridad/i);
  assert.equal(item.report_id, 'r');
  assert.equal(item.input_declaration, undefined);
});

test('queue follows the operational dependency order and refuses self review', () => {
  assert.equal(state({ report: null }), 'awaiting_report');
  assert.equal(state({ reviewerId: 'operator' }), 'self_authored');
  assert.equal(state({ plannedInputCount: 1 }), 'awaiting_inputs');
  assert.equal(state({ plannedInputCount: 1, report: { ...report,
    input_declaration: { items: [{}] } } }), 'human_review');
  assert.equal(state({ exceptions: [{ review_status: 'submitted' }] }), 'pending_exception');
  assert.equal(state({ exceptions: [{ review_status: 'rejected' }] }), 'rejected_exception');
  assert.equal(state({ exceptions: [
    { review_status: 'approved' }, { review_status: 'submitted' }] }), 'pending_exception');
  assert.equal(state({ order: { ...order, type: 'application' } }), 'awaiting_evidence');
  assert.equal(state({ order: { ...order, type: 'fertilization' }, evidenceCount: 1 }), 'human_review');
  assert.equal(state({ report: { ...report, review_status: 'verified' } }), 'ready_for_closure');
});

test('no private payloads, notes, proofs or tenant ids escape in queue summaries', () => {
  const item = classifyReviewQueueItem({
    ...args,
    order: { ...order, instructions: 'PRIVATE_INSTRUCTIONS', tenant_id: 'TENANT_SECRET' },
    report: { ...report, result_summary: 'PRIVATE_REPORT', content_sha256: 'SECRET_HASH' },
    exceptions: [{ review_status: 'approved', reason: 'PRIVATE_REASON' }]
  });
  const serialized = JSON.stringify(item);
  assert.doesNotMatch(serialized, /PRIVATE_INSTRUCTIONS|TENANT_SECRET|PRIVATE_REPORT|SECRET_HASH|PRIVATE_REASON/);
  assert.deepEqual(Object.keys(item).sort(), [
    'due_at', 'id', 'priority', 'reason', 'report_id', 'state', 'status', 'title', 'type'
  ]);
});

test('invalid or incomplete server aggregates fail instead of fabricating readiness', () => {
  assert.throws(() => classifyReviewQueueItem({ ...args, reviewerId: null }), /Incomplete/);
  assert.throws(() => classifyReviewQueueItem({ ...args, plannedInputCount: -1 }), /Incomplete/);
  assert.throws(() => classifyReviewQueueItem({ ...args, exceptions: null }), /Incomplete/);
  assert.throws(() => classifyReviewQueueItem({ ...args, order: { ...order, status: 'completed' } }), /Incomplete/);
});

test('verified report outranks pending, pending selection prefers deterministic newest ordered row', () => {
  const sorted = [
    { id: 'new', work_order_id: 'A', review_status: 'submitted' },
    { id: 'older', work_order_id: 'A', review_status: 'submitted' },
    { id: 'verified', work_order_id: 'A', review_status: 'verified' },
    { id: 'newer', work_order_id: 'B', review_status: 'submitted' },
    { id: 'olderB', work_order_id: 'B', review_status: 'submitted' }
  ];
  const selected = selectReviewQueueReports(sorted);
  assert.equal(selected.get('A').id, 'verified');
  assert.equal(selected.get('B').id, 'newer');
  assert.equal(selectReviewQueueReports([]).size, 0);
});
