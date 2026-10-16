import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildVerifiedReviewChecklist, operationReviewLabel,
  reviewChecklistOutcome, ORDER_TYPES_WITH_REQUIRED_EVIDENCE
} from '../src/services/reviewChecklist.js';

const complete = { time_checked: true, area_checked: true,
  result_checked: true, operation_checked: true, evidence_basis: 'reviewed_files' };

test('a positive review requires four explicit controls and an evidence basis', () => {
  assert.deepEqual(buildVerifiedReviewChecklist(complete, 'application'), complete);
  assert.throws(() => buildVerifiedReviewChecklist({}, 'inspection'), /cuatro controles/);
  assert.throws(() => buildVerifiedReviewChecklist({
    ...complete, time_checked: false }, 'inspection'), /cuatro controles/);
  assert.throws(() => buildVerifiedReviewChecklist({
    ...complete, evidence_basis: '' }, 'inspection'), /archivos/);
  assert.throws(() => buildVerifiedReviewChecklist({
    ...complete, evidence_basis: 'no_files' }, 'fertilization'), /adjunto privado/);
  assert.deepEqual(ORDER_TYPES_WITH_REQUIRED_EVIDENCE, ['application', 'fertilization']);
});

test('every supported task type has a specific, non-sensor review instruction', () => {
  for (const type of ['application', 'sowing', 'fertilization', 'harvest', 'irrigation', 'inspection', 'other']) {
    assert.ok(operationReviewLabel(type).length >= 30);
  }
});

test('legacy verification is clearly distinguishable from structured newer review', () => {
  assert.equal(reviewChecklistOutcome({ review_status: 'verified', review_checklist: null }), null);
  assert.equal(reviewChecklistOutcome({ review_status: 'rejected', review_checklist: complete }), null);
  assert.deepEqual(reviewChecklistOutcome({ review_status: 'verified',
    review_checklist: complete }), complete);
});

test('UI gates affirmative review with real checklist and does not treat it as physical proof', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /buildVerifiedReviewChecklist\(reviewChecks\[report.id\], order.type\)/);
  assert.match(ui, /review_checklist/);
  assert.match(ui, /Revisión histórica/);
  assert.match(ui, /decision === 'rejected' \? \{ reason \} : \{ checklist \}/);
  assert.match(ui, /no acredita por sí misma/);
});
