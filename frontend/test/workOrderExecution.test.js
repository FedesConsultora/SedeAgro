import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  executionReports, canDeclareExecution, canReviewExecutionReport,
  toExecutionTimestamp, buildExecutionDraft, validatedExecutionResponse
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

test('execution preflight submits only normalized backend-compatible UTC payload', () => {
  const now = new Date('2026-10-30T15:00:00Z');
  const payload = buildExecutionDraft({
    started: '2026-10-30T09:30:00-03:00',
    finished: '2026-10-30T10:15:00-03:00',
    approvedAt: '2026-10-30T12:00:00Z',
    area: '12.50', outcome: '  Control de malezas realizado.  '
  }, now);
  assert.deepEqual(payload, {
    started_at: '2026-10-30T12:30:00.000Z',
    finished_at: '2026-10-30T13:15:00.000Z',
    worked_area_hectares: 12.5,
    result_summary: 'Control de malezas realizado.'
  });
  assert.equal(buildExecutionDraft({
    started: '2026-10-30T12:00:00Z', finished: '2026-10-30T15:05:00Z',
    approvedAt: '2026-10-30T12:00:00Z', area: '0.01', outcome: 'Trabajo finalizado.'
  }, now).worked_area_hectares, 0.01, 'approval and 5-minute backend boundary are inclusive');
});

test('execution preflight refuses invalid windows, missing approval and impossible quantities', () => {
  const now = new Date('2026-10-30T15:00:00Z');
  const valid = {
    started: '2026-10-30T12:30:00Z', finished: '2026-10-30T13:15:00Z',
    approvedAt: '2026-10-30T12:00:00Z',
    area: '10.25', outcome: 'Trabajo finalizado.'
  };
  const invalid = [
    [{ approvedAt: null }, /aprobaci.*v.*lida/i],
    [{ started: '2026-10-30T11:59:00Z' }, /anterior a la aprobaci/i],
    [{ finished: '2026-10-30T12:29:00Z' }, /anterior al inicio/i],
    [{ finished: '2026-10-30T15:05:01Z' }, /futuro/i],
    [{ finished: 'invalid-date' }, /fecha y hora/i],
    [{ area: '' }, /superficie/i],
    [{ area: '0' }, /superficie/i],
    [{ area: '10.255' }, /dos decimales/i],
    [{ area: '1000000.01' }, /superficie/i],
    [{ area: 'Infinity' }, /superficie/i],
    [{ outcome: 'corto' }, /resultado/i],
    [{ outcome: 'x'.repeat(2001) }, /resultado/i]
  ];
  for (const [patch, pattern] of invalid) {
    assert.throws(() => buildExecutionDraft({ ...valid, ...patch }, now), pattern,
      JSON.stringify(Object.keys(patch)));
  }
});

test('execution UI preflight occurs before live POST without claiming local success', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /buildExecutionDraft\(\{[\s\S]*approvedAt: order\.approved_at/);
  assert.ok(ui.indexOf('const body = buildExecutionDraft(') <
    ui.indexOf('const response = await api.request('));
  assert.match(ui, /validatedExecutionResponse\(response, order\.id, 'submitted'\)/);
});
