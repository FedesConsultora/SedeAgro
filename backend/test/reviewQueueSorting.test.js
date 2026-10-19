import test from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { REVIEW_QUEUE_SORT_MODES, isValidReviewSortKey, reviewQueueSortKey,
  reviewQueueSortOrder, reviewQueueOlderWhere } from '../src/modules/workOrders/reviewQueueSorting.js';

test('three global sorts have deterministic keysets and explicit null semantics', () => {
  assert.deepEqual(REVIEW_QUEUE_SORT_MODES, ['newest','due_first','priority_first']);
  assert.equal(reviewQueueSortKey('newest', {}), null);
  assert.equal(reviewQueueSortKey('due_first', { due_at:null }),null);
  assert.equal(reviewQueueSortKey('due_first',{ due_at:'2026-10-20T12:00:00.123Z'}),
    '2026-10-20T12:00:00.123Z');
  assert.deepEqual(['urgent','high','normal','low'].map(priority =>
    reviewQueueSortKey('priority_first',{priority})),[0,1,2,3]);
  for (const mode of REVIEW_QUEUE_SORT_MODES) {
    const order = reviewQueueSortOrder(mode);
    assert.equal(order.at(-2)[1],'DESC');
    assert.deepEqual(order.at(-1),['id','DESC']);
  }
  assert.equal(reviewQueueSortOrder('due_first')[0][1],'ASC NULLS LAST');
  assert.equal(reviewQueueSortOrder('priority_first')[0][1],'ASC');
  for (const bad of ['inferred','oldest','updated','deadline']) {
    assert.throws(()=>reviewQueueSortKey(bad,{}),/inválido/);
    assert.throws(()=>reviewQueueSortOrder(bad),/inválido/);
  }
});

test('sort cursors reject invalid keys and preserve tie ordering', () => {
  const cursor = { lastDate: new Date('2026-10-19T16:00:00Z'),
    lastId: 'c1ea0a4f-fc00-4f80-8300-312035b4046c', sortKey:null };
  assert.equal(isValidReviewSortKey('newest', null),true);
  assert.equal(isValidReviewSortKey('newest',0),false);
  assert.equal(isValidReviewSortKey('due_first',null),true);
  assert.equal(isValidReviewSortKey('due_first','invalid'),false);
  assert.equal(isValidReviewSortKey('priority_first',4),true);
  assert.equal(isValidReviewSortKey('priority_first',5),false);
  assert.equal(isValidReviewSortKey('priority_first','2'),false);
  const newest=reviewQueueOlderWhere('newest',cursor);
  assert.equal(newest[Op.or].length,2);
  const lastNull=reviewQueueOlderWhere('due_first',cursor);
  assert.equal(lastNull[Op.and].length,2);
  const dated=reviewQueueOlderWhere('due_first',{...cursor,
    sortKey:'2026-10-20T12:00:00.000Z'});
  assert.equal(dated[Op.or].length,3,'older due dates, same date tie, then NULL');
  const priority=reviewQueueOlderWhere('priority_first',{...cursor,sortKey:0});
  assert.equal(priority[Op.or].length,2);
  assert.throws(()=>reviewQueueOlderWhere('priority_first',cursor),/inválida/);
});
