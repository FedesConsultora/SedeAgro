import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { REVIEW_QUEUE_STATE_GROUPS, reviewQueueStateSql } from '../src/modules/workOrders/reviewQueueStateSql.js';
import { REVIEW_QUEUE_STATES, classifyReviewQueueItem } from '../src/modules/workOrders/reviewQueuePolicy.js';

test('SQL filter groups partition the exact server-authoritative eight review states', () => {
  const groups = REVIEW_QUEUE_STATE_GROUPS;
  assert.deepEqual(Object.keys(groups), ['all', 'no_report', 'blocked', 'review', 'closure']);
  const members = Object.entries(groups).filter(([name]) => name !== 'all')
    .flatMap(([, states]) => states);
  assert.equal(members.length, 8);
  assert.deepEqual(new Set(members), new Set(REVIEW_QUEUE_STATES));
  assert.equal(groups.all, null);
});
test('SQL projection encodes the precedence of the JS reviewer policy, with no user SQL fragments', () => {
  const reviewer = randomUUID();
  const sql = reviewQueueStateSql(reviewer);
  const cases = ['awaiting_report','ready_for_closure','self_authored',
    'awaiting_inputs','rejected_exception','pending_exception',
    'awaiting_evidence','human_review'];
  let offset = -1;
  for (const name of cases) {
    const position = sql.indexOf("'"+name+"'");
    assert.ok(position > offset, name + ' must follow previous precedence case');
    offset = position;
  }
  assert.match(sql, /ORDER BY \(r\.review_status = 'verified'\) DESC, r\.created_at DESC, r\.id DESC/);
  assert.match(sql, /LATERAL/);
  assert.match(sql, /"WorkOrder"\.tenant_id/);
  assert.match(sql, /work_order_executions/);
  assert.match(sql, /work_order_execution_exceptions/);
  assert.match(sql, /evidence_assets/);
  assert.match(sql, /jsonb_array_length/);
  assert.throws(() => reviewQueueStateSql("x' OR true --"), /UUID required/);
  assert.throws(() => reviewQueueStateSql(null), /UUID required/);
});
test('global state categories preserve the existing advisory classification semantics', () => {
  const order = { id: randomUUID(), title:'t', status:'in_progress', type:'inspection' };
  const reviewer = randomUUID();
  const state = args => classifyReviewQueueItem({
    order, report:null, plannedInputCount:0, exceptions:[], evidenceCount:0,
    reviewerId:reviewer, ...args
  }).state;
  assert.equal(state({}), REVIEW_QUEUE_STATE_GROUPS.no_report[0]);
  assert.ok(REVIEW_QUEUE_STATE_GROUPS.closure.includes(state({report:{
    id:randomUUID(), review_status:'verified'
  }})));
  assert.ok(REVIEW_QUEUE_STATE_GROUPS.blocked.includes(state({report:{
    id:randomUUID(), review_status:'submitted', submitted_by:reviewer
  }})));
});
