import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { REVIEW_QUEUE_DUE_WINDOWS } from '../src/modules/workOrders/reviewQueueDueWindow.js';
import { issueReviewCursor, parseReviewCursor, REVIEW_CURSOR_TTL_MS,
  ReviewCursorError, REVIEW_QUEUE_WORK_TYPES, REVIEW_QUEUE_STATE_FILTERS,
  REVIEW_QUEUE_PRIORITIES } from '../src/modules/workOrders/reviewQueueCursor.js';

const tenantId = randomUUID(), userId = randomUUID(), otherTenant = randomUUID(),
  otherUser = randomUUID(), lastId = randomUUID();
const now = Date.parse('2026-10-18T17:00:00.000Z');
const anchor = new Date(now);
const issued = () => issueReviewCursor({
  tenantId, userId, anchor, last: { id: lastId,
    created_at: new Date(now - 18000) }
}, now);

test('opaque, signed cursor retains ordering anchor and final tuple', () => {
  const cursor = issued();
  assert.ok(cursor.length > 40 && cursor.length < 1024);
  assert.doesNotMatch(cursor, new RegExp(tenantId));
  assert.doesNotMatch(cursor, new RegExp(userId));
  const parsed = parseReviewCursor(cursor, { tenantId, userId }, now + 10000);
  assert.equal(parsed.anchor.toISOString(), anchor.toISOString());
  assert.equal(parsed.lastDate.toISOString(), new Date(now - 18000).toISOString());
  assert.equal(parsed.lastId, lastId);
});

test('cursor cannot be replayed by another tenant or identity or modified without signature', () => {
  const cursor = issued();
  const context = { tenantId, userId };
  assert.throws(() => parseReviewCursor(cursor, { tenantId: otherTenant, userId }, now), ReviewCursorError);
  assert.throws(() => parseReviewCursor(cursor, { tenantId, userId: otherUser }, now), ReviewCursorError);
  assert.throws(() => parseReviewCursor(cursor.replace(/.$/, x => x === 'a' ? 'b' : 'a'),
    context, now), ReviewCursorError);
  assert.throws(() => parseReviewCursor(cursor + '!', context, now), ReviewCursorError);
  assert.throws(() => parseReviewCursor('x'.repeat(1030), context, now), ReviewCursorError);
});

test('cursor has finite lifetime and no future anchor or reverse ordering', () => {
  const cursor = issued();
  const context = { tenantId, userId };
  assert.equal(parseReviewCursor(cursor, context, now + REVIEW_CURSOR_TTL_MS - 1).lastId, lastId);
  assert.throws(() => parseReviewCursor(cursor, context, now + REVIEW_CURSOR_TTL_MS), ReviewCursorError);
  assert.throws(() => issueReviewCursor({ tenantId, userId, anchor, last: {
    id: lastId, created_at: new Date(now + 20000) } }, now), ReviewCursorError);
});

test('v2 cursor binds allowed global work type before keyset pagination', () => {
  const make = workType => issueReviewCursor({ tenantId, userId, workType, anchor,
    last: { id: lastId, created_at: new Date(now - 18000) } }, now);
  assert.deepEqual(REVIEW_QUEUE_WORK_TYPES,
    ['all', 'application', 'sowing', 'fertilization', 'harvest',
      'irrigation', 'inspection', 'other']);
  for (const workType of REVIEW_QUEUE_WORK_TYPES) {
    const cursor = make(workType);
    assert.equal(parseReviewCursor(cursor, { tenantId, userId, workType }, now).workType,
      workType);
    for (const wrongType of REVIEW_QUEUE_WORK_TYPES.filter(t => t !== workType)) {
      assert.throws(() => parseReviewCursor(cursor, { tenantId, userId,
        workType: wrongType }, now), ReviewCursorError);
    }
  }
  assert.throws(() => make('unrestricted'), ReviewCursorError);
  assert.throws(() => parseReviewCursor(issued(), { tenantId, userId,
    workType: 'unrestricted' }, now), ReviewCursorError);
});

test('v3 state-filter cursor rejects replay under a different global state', () => {
  assert.deepEqual(REVIEW_QUEUE_STATE_FILTERS, [
    'all', 'no_report', 'blocked', 'review', 'closure'
  ]);
  for (const reviewState of REVIEW_QUEUE_STATE_FILTERS) {
    const signed = issueReviewCursor({
      tenantId, userId, workType:'inspection', reviewState, anchor,
      last: { id:lastId, created_at:new Date(now - 18000) }
    }, now);
    assert.equal(parseReviewCursor(signed, {
      tenantId, userId, workType:'inspection', reviewState
    },now).reviewState, reviewState);
    for (const other of REVIEW_QUEUE_STATE_FILTERS.filter(x => x !== reviewState)) {
      assert.throws(() => parseReviewCursor(signed, {
        tenantId, userId, workType:'inspection', reviewState:other
      }, now), ReviewCursorError);
    }
  }
  assert.throws(() => issueReviewCursor({
    tenantId,userId,reviewState:'invalid',anchor,
    last:{id:lastId,created_at:new Date(now - 18000)}
  },now), ReviewCursorError);
});

test('v4 cursor binds priority and prohibits cross-priority replay', () => {
  assert.deepEqual(REVIEW_QUEUE_PRIORITIES, ['all', 'urgent', 'high', 'normal', 'low']);
  for (const priority of REVIEW_QUEUE_PRIORITIES) {
    const token = issueReviewCursor({
      tenantId, userId, workType:'application', reviewState:'blocked', priority,
      anchor, last:{id:lastId,created_at:new Date(now-18000)}
    }, now);
    const context = {tenantId,userId,workType:'application',reviewState:'blocked',priority};
    assert.equal(parseReviewCursor(token, context, now).priority, priority);
    for (const different of REVIEW_QUEUE_PRIORITIES.filter(v=>v!==priority)) {
      assert.throws(()=>parseReviewCursor(token,{...context,priority:different},now), ReviewCursorError);
    }
    assert.throws(()=>parseReviewCursor(token,{...context,tenantId:otherTenant},now),ReviewCursorError);
    assert.throws(()=>parseReviewCursor(token,{...context,userId:otherUser},now),ReviewCursorError);
  }
  assert.throws(()=>issueReviewCursor({
    tenantId,userId,priority:'injection',anchor,
    last:{id:lastId,created_at:new Date(now-18000)}
  },now),ReviewCursorError);
});

test('v5 signed cursor carries the anchored due window and rejects cross-window replay', () => {
  assert.deepEqual(REVIEW_QUEUE_DUE_WINDOWS,
    ['all','overdue','next_7_days','later','unscheduled']);
  for (const dueWindow of REVIEW_QUEUE_DUE_WINDOWS) {
    const token = issueReviewCursor({
      tenantId,userId,workType:'inspection',reviewState:'no_report',
      priority:'normal',dueWindow,anchor,
      last:{id:lastId,created_at:new Date(now-18000)}
    },now);
    const context={tenantId,userId,workType:'inspection',reviewState:'no_report',
      priority:'normal',dueWindow};
    const parsed=parseReviewCursor(token,context,now+1000);
    assert.equal(parsed.dueWindow,dueWindow);
    assert.equal(parsed.anchor.toISOString(),anchor.toISOString());
    for (const changed of REVIEW_QUEUE_DUE_WINDOWS.filter(x=>x!==dueWindow)) {
      assert.throws(()=>parseReviewCursor(token,{...context,dueWindow:changed},now+1000),
        ReviewCursorError);
    }
    assert.throws(()=>parseReviewCursor(token,{...context,tenantId:otherTenant},now+1000),
      ReviewCursorError);
    assert.throws(()=>parseReviewCursor(token,{...context,userId:otherUser},now+1000),
      ReviewCursorError);
  }
  assert.throws(()=>issueReviewCursor({tenantId,userId,dueWindow:'unlimited',
    anchor,last:{id:lastId,created_at:new Date(now-18000)}},now),ReviewCursorError);
  assert.throws(()=>parseReviewCursor(issued(),{tenantId,userId,dueWindow:'unlimited'},now),
    ReviewCursorError);
});
