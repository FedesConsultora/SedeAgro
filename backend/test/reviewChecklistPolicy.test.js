import test from 'node:test';
import assert from 'node:assert/strict';
import { canAcceptReviewChecklist, executionReviewRequirement,
  EVIDENCE_REQUIRED_ORDER_TYPES } from '../src/modules/workOrders/reviewChecklistPolicy.js';

const checked = { time_checked: true, area_checked: true,
  result_checked: true, operation_checked: true, evidence_basis: 'no_files' };

test('application and fertilization require a linked file and reviewer acknowledgement', () => {
  assert.deepEqual(EVIDENCE_REQUIRED_ORDER_TYPES, ['application', 'fertilization']);
  for (const type of EVIDENCE_REQUIRED_ORDER_TYPES) {
    assert.equal(executionReviewRequirement(type).evidence_required, true);
    assert.equal(canAcceptReviewChecklist(type, checked, 0), false);
    assert.equal(canAcceptReviewChecklist(type, { ...checked, evidence_basis: 'reviewed_files' }, 1), true);
    assert.equal(canAcceptReviewChecklist(type, checked, 1), false);
  }
});

test('other order types may acknowledge explicit absence; cannot claim files without any', () => {
  for (const type of ['inspection', 'irrigation', 'harvest', 'sowing', 'other']) {
    assert.equal(executionReviewRequirement(type).evidence_required, false);
    assert.equal(canAcceptReviewChecklist(type, checked, 0), true);
    assert.equal(canAcceptReviewChecklist(type, { ...checked, evidence_basis: 'reviewed_files' }, 0), false);
    assert.equal(canAcceptReviewChecklist(type, { ...checked, evidence_basis: 'reviewed_files' }, 2), true);
  }
});

test('all four controls and bounded attachment count must be honest booleans', () => {
  for (const field of ['time_checked', 'area_checked', 'result_checked', 'operation_checked']) {
    assert.equal(canAcceptReviewChecklist('inspection', { ...checked, [field]: false }, 0), false);
    assert.equal(canAcceptReviewChecklist('inspection', { ...checked, [field]: 'true' }, 0), false);
  }
  assert.equal(canAcceptReviewChecklist('inspection', null, 0), false);
  assert.equal(canAcceptReviewChecklist('inspection', checked, -1), false);
  assert.equal(canAcceptReviewChecklist('inspection', checked, NaN), false);
  assert.equal(canAcceptReviewChecklist('inspection', checked, 2), false);
});
