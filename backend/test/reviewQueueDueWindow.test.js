import test from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { REVIEW_QUEUE_DUE_WINDOWS, REVIEW_QUEUE_DUE_SPAN_MS,
  reviewQueueDueWhere } from '../src/modules/workOrders/reviewQueueDueWindow.js';

test('global due windows are disjoint with exact inclusive/exclusive cutoffs', () => {
  const anchor = new Date('2026-10-19T12:30:00.000Z');
  const end = new Date(anchor.getTime() + REVIEW_QUEUE_DUE_SPAN_MS);
  assert.deepEqual(REVIEW_QUEUE_DUE_WINDOWS,
    ['all', 'overdue', 'next_7_days', 'later', 'unscheduled']);
  assert.equal(REVIEW_QUEUE_DUE_SPAN_MS, 604800000);
  assert.deepEqual(reviewQueueDueWhere('all', anchor), {});
  const overdue = reviewQueueDueWhere('overdue', anchor).due_at;
  const upcoming = reviewQueueDueWhere('next_7_days', anchor).due_at;
  const later = reviewQueueDueWhere('later', anchor).due_at;
  assert.equal(overdue[Op.lt].toISOString(), anchor.toISOString());
  assert.equal(upcoming[Op.gte].toISOString(), anchor.toISOString());
  assert.equal(upcoming[Op.lt].toISOString(), end.toISOString());
  assert.equal(later[Op.gte].toISOString(), end.toISOString());
  assert.equal(reviewQueueDueWhere('unscheduled', anchor).due_at[Op.is], null);
  const matches = (value, group) => {
    if (value === null) return group === 'unscheduled';
    if (group === 'overdue') return value < overdue[Op.lt];
    if (group === 'next_7_days') return value >= upcoming[Op.gte] && value < upcoming[Op.lt];
    if (group === 'later') return value >= later[Op.gte];
    return false;
  };
  for (const value of [null,new Date(anchor.getTime()-1),anchor,
    new Date(end.getTime()-1),end,new Date(end.getTime()+1)]) {
    assert.equal(['overdue','next_7_days','later','unscheduled']
      .filter(group=>matches(value,group)).length,1,'categories must partition deadline values');
  }
  assert.throws(()=>reviewQueueDueWhere('yesterday',anchor),/Invalid/);
  assert.throws(()=>reviewQueueDueWhere('all',new Date(NaN)),/Invalid/);
  assert.throws(()=>reviewQueueDueWhere('all','2026-10-19'),/Invalid/);
});
