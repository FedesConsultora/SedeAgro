import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canSubmitExecution, canReviewExecution, canCloseReviewedOrder,
  validExecutionWindow, MAX_EXECUTION_REPORTS
} from '../src/modules/workOrders/executionPolicy.js';

test('reports belong to a real assigned executor or tenant coordinator', () => {
  assert.equal(canSubmitExecution('contractor', true), true);
  assert.equal(canSubmitExecution('contractor', false), false);
  assert.equal(canSubmitExecution('scout', true), false);
  assert.equal(canSubmitExecution('tenant_admin', false), true);
  assert.equal(canSubmitExecution('agronomic_coordinator', false), true);
});

test('independent coordination review never accepts author as reviewer', () => {
  assert.equal(canReviewExecution('tenant_admin', 'a', 'a'), false);
  assert.equal(canReviewExecution('agronomic_coordinator', 'b', 'a'), true);
  assert.equal(canReviewExecution('contractor', 'b', 'a'), false);
  assert.equal(canReviewExecution('tenant_admin', null, 'a'), false);
});

test('completion requires reviewed record and coordinating role, never a raw status click', () => {
  assert.equal(canCloseReviewedOrder('contractor', [{ review_status: 'verified' }]), false);
  assert.equal(canCloseReviewedOrder('tenant_admin', []), false);
  assert.equal(canCloseReviewedOrder('tenant_admin', [{ review_status: 'submitted' }]), false);
  assert.equal(canCloseReviewedOrder('agronomic_coordinator', [{ review_status: 'verified' }]), true);
  assert.equal(MAX_EXECUTION_REPORTS, 20);
});

test('reported execution window must be after approval and not in future', () => {
  const now = new Date('2026-10-15T15:00:00Z');
  const approval = new Date('2026-10-15T10:00:00Z');
  assert.equal(validExecutionWindow(new Date('2026-10-15T11:00:00Z'), new Date('2026-10-15T14:00:00Z'), approval, now), true);
  assert.equal(validExecutionWindow(new Date('2026-10-15T09:00:00Z'), new Date('2026-10-15T14:00:00Z'), approval, now), false);
  assert.equal(validExecutionWindow(new Date('2026-10-15T14:00:00Z'), new Date('2026-10-15T13:00:00Z'), approval, now), false);
  assert.equal(validExecutionWindow(new Date('2026-10-15T14:00:00Z'), new Date('2026-10-15T16:00:00Z'), approval, now), false);
  assert.equal(validExecutionWindow(new Date('invalid'), new Date('2026-10-15T14:00:00Z'), approval, now), false);
});
