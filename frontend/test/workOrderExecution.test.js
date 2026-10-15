import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  executionReports, canDeclareExecution, canReviewExecutionReport,
  toExecutionTimestamp, validatedExecutionResponse
} from '../src/services/workOrderExecution.js';

const report = (status, by = 'worker') => ({ id: 'report1', work_order_id: 'order1', submitted_by: by, review_status: status });
const order = (status, reports = []) => ({ id: 'order1', status, WorkOrderAssignees: [{ user_id: 'worker' }], WorkOrderExecutions: reports });

test('only eligible live operators can declare execution, and pending reports suppress duplicates', () => {
  assert.equal(canDeclareExecution(order('in_progress'), 'contractor', 'worker', true), true);
  assert.equal(canDeclareExecution(order('in_progress'), 'contractor', 'intruder', true), false);
  assert.equal(canDeclareExecution(order('in_progress'), 'tenant_admin', 'admin', true), true);
  assert.equal(canDeclareExecution(order('approved'), 'tenant_admin', 'admin', true), false);
  assert.equal(canDeclareExecution(order('in_progress'), 'contractor', 'worker', false), false);
  assert.equal(canDeclareExecution(order('in_progress', [report('submitted')]), 'contractor', 'worker', true), false);
  assert.equal(canDeclareExecution(order('in_progress', [report('verified')]), 'contractor', 'worker', true), false);
  assert.equal(canDeclareExecution(order('in_progress', [report('rejected')]), 'contractor', 'worker', true), true);
  assert.deepEqual(executionReports({}), []);
});

test('review is shown only to a distinct active coordinating account', () => {
  const pending = report('submitted');
  assert.equal(canReviewExecutionReport(order('in_progress', [pending]), pending, 'tenant_admin', 'admin', true), true);
  assert.equal(canReviewExecutionReport(order('in_progress', [pending]), pending, 'tenant_admin', 'worker', true), false);
  assert.equal(canReviewExecutionReport(order('in_progress', [pending]), pending, 'contractor', 'other', true), false);
  assert.equal(canReviewExecutionReport(order('completed', [pending]), pending, 'tenant_admin', 'admin', true), false);
  assert.equal(canReviewExecutionReport(order('in_progress', [report('verified')]), report('verified'), 'tenant_admin', 'admin', true), false);
});

test('timestamps are offset-aware and writes require exact server confirmation', () => {
  assert.equal(toExecutionTimestamp('2026-10-15T13:30').endsWith('Z'), true);
  assert.throws(() => toExecutionTimestamp(''), /fecha y hora/);
  assert.deepEqual(validatedExecutionResponse({ data: report('submitted') }, 'order1', 'submitted'), report('submitted'));
  assert.throws(() => validatedExecutionResponse({ data: report('submitted') }, 'other', 'submitted'), /no confirmó/);
  assert.throws(() => validatedExecutionResponse({ data: report('verified') }, 'order1', 'submitted'), /no confirmó/);
});

test('detail only offers completion after server-returned verified report', async () => {
  const { availableWorkOrderTransitions } = await import('../src/services/workOrderDetails.js');
  assert.deepEqual(availableWorkOrderTransitions(order('in_progress'), 'tenant_admin', 'admin', true), ['cancelled']);
  assert.deepEqual(availableWorkOrderTransitions(order('in_progress', [report('submitted')]), 'tenant_admin', 'admin', true), ['cancelled']);
  assert.deepEqual(availableWorkOrderTransitions(order('in_progress', [report('verified')]), 'tenant_admin', 'admin', true), ['completed', 'cancelled']);
  assert.deepEqual(availableWorkOrderTransitions(order('in_progress', [report('verified')]), 'contractor', 'worker', true), []);
});

test('execution UI uses real POST endpoints and never infers success', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  const drawer = readFileSync(new URL('../src/components/WorkOrderDetailDrawer.jsx', import.meta.url), 'utf8');
  assert.match(ui, /validatedExecutionResponse\(response, order\.id, 'submitted'\)/);
  assert.match(ui, /validatedExecutionResponse\(response, order\.id, decision, report\.id\)/);
  assert.match(ui, /canReviewExecutionReport/);
  assert.match(ui, /Declar.*informaci.*corresponde/);
  assert.match(drawer, /<WorkOrderExecutionPanel order=\{detail\} onChanged=\{refresh\}/);
});
