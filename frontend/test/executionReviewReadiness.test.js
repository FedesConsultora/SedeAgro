import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  reportSignature, exceptionReadinessForReview
} from '../src/services/executionReviewReadiness.js';

const report = { id: 'r1', review_status: 'submitted' };
const old = { id: 'r0', review_status: 'rejected' };
const order = { id: 'o1', status: 'in_progress', WorkOrderExecutions: [report, old] };
const ready = { orderId: 'o1', reportSignature: 'r1|r0', phase: 'ready', items: [] };
const exception = { id: 'e1', work_order_execution_id: 'r1', review_status: 'submitted' };

test('acceptance fails closed before a real matching server response, on error and on stale account/order', () => {
  assert.equal(reportSignature([report, old]), 'r1|r0');
  assert.equal(reportSignature([{ foo: 1 }]), null);
  assert.equal(exceptionReadinessForReview(order, report, null).allowed, false);
  assert.equal(exceptionReadinessForReview(order, report, { ...ready, phase: 'loading' }).allowed, false);
  assert.equal(exceptionReadinessForReview(order, report, { ...ready, phase: 'error' }).allowed, false);
  assert.match(exceptionReadinessForReview(order, report, { ...ready, phase: 'error' }).reason, /Reintentá/);
  assert.equal(exceptionReadinessForReview(order, report, { ...ready, orderId: 'other' }).allowed, false);
  assert.equal(exceptionReadinessForReview(order, report, { ...ready, reportSignature: 'old' }).allowed, false);
  assert.equal(exceptionReadinessForReview({ ...order, WorkOrderExecutions: [report] },
    report, ready).allowed, false);
  assert.equal(exceptionReadinessForReview(order, { id: 'missing' }, ready).allowed, false);
});

test('only all approved exceptions permit positive review, independently of other reports', () => {
  assert.equal(exceptionReadinessForReview(order, report, ready).allowed, true);
  assert.equal(exceptionReadinessForReview(order, report,
    { ...ready, items: [{ ...exception, review_status: 'approved' }] }).allowed, true);
  assert.equal(exceptionReadinessForReview(order, report, { ...ready, items: [exception] }).allowed, false);
  assert.match(exceptionReadinessForReview(order, report,
    { ...ready, items: [exception] }).reason, /pendientes/);
  assert.match(exceptionReadinessForReview(order, report, { ...ready,
    items: [{ ...exception, review_status: 'rejected' }] }).reason, /Rechazá el parte/);
  assert.equal(exceptionReadinessForReview(order, report, { ...ready,
    items: [{ ...exception, work_order_execution_id: 'r0', review_status: 'rejected' }] }).allowed, true,
  'A rejected historical report must not prevent independently reviewing its corrected replacement');
});

test('inconsistent history, malformed status or foreign report never becomes an empty list', () => {
  for (const items of [null, [null], [{}], [{ ...exception, review_status: 'unknown' }],
    [{ ...exception, work_order_execution_id: 'foreign-report' }]]) {
    assert.equal(exceptionReadinessForReview(order, report, { ...ready, items }).allowed, false);
  }
});

test('real React component blocks positive review in UI and action while preserving reject', () => {
  const panel = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  const child = readFileSync(new URL('../src/components/WorkOrderExecutionExceptions.jsx', import.meta.url), 'utf8');
  assert.match(panel, /exceptionReadinessForReview\(order, report, exceptionReadiness\)/);
  assert.match(panel, /!exceptionReadinessForReview\(order, report, exceptionReadiness\)\.allowed/);
  assert.match(panel, /onReadinessChanged=\{onReadinessChanged\}/);
  assert.match(child, /phase: 'loading'/);
  assert.match(child, /phase: 'ready'/);
  assert.match(child, /phase: 'error'/);
  assert.match(child, /onReadinessChanged\?\./);
  assert.match(child, /loaded && !error && linked.length === 0/);
});

test('Chromium modal acceptance waits for enabled state, still asserts real focus/escape', () => {
  const acceptance = readFileSync(new URL('../../scripts/acceptance-browser-cookie.mjs', import.meta.url), 'utf8');
  const section = acceptance.slice(acceptance.indexOf('// 0T.1: real authenticated portal;'),
    acceptance.indexOf('// An actual live lookup failure'));
  const helper = readFileSync(new URL('../../scripts/support/assert-dialog-focus.mjs', import.meta.url), 'utf8');
  assert.match(section, /waitForFunction\(/);
  assert.match(section, /create && !create.disabled/);
  assert.match(section, /for \(let cycle = 1; cycle <= 4; cycle \+= 1\)/);
  assert.match(section, /assertDialogFocus\(/);
  assert.match(section, /await page1.keyboard.press\('Shift\+Tab'\)/);
  assert.match(section, /await page1.keyboard.press\('Escape'\)/);
  assert.match(helper, /document.activeElement === expected/);
  assert.match(helper, /timeout: 750/);
  assert.match(helper, /activeInsideDialog/);
  assert.doesNotMatch(helper, /innerHTML|outerHTML|innerText|\.value\b/);
});
