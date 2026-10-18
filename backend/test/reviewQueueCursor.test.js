import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { issueReviewCursor, parseReviewCursor, REVIEW_CURSOR_TTL_MS,
  ReviewCursorError } from '../src/modules/workOrders/reviewQueueCursor.js';

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
