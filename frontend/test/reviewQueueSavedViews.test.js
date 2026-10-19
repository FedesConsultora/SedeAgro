import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewViewName, reviewViewFilters, validateSavedViews,
  validateSavedView, REVIEW_VIEW_LIMIT, REVIEW_VIEWS_PATH
} from '../src/services/reviewQueueSavedViews.js';

const filters = {workType:'inspection',reviewState:'no_report',
  priority:'urgent',dueWindow:'overdue',titleQuery:'Control',sortMode:'due_first'};
test('saved views strictly normalize names and accept only six safe filter keys',()=>{
  assert.equal(REVIEW_VIEW_LIMIT,10);
  assert.equal(REVIEW_VIEWS_PATH,'/work-orders/review-queue/views');
  assert.equal(normalizeReviewViewName('   Mis   urgentes '),'Mis urgentes');
  assert.deepEqual(reviewViewFilters(filters),filters);
  assert.throws(()=>reviewViewFilters({...filters,cursor:'signed'}),/no son válidos/);
  assert.throws(()=>reviewViewFilters({...filters,workType:'none'}),/no son válidos/);
  assert.throws(()=>reviewViewFilters({...filters,titleQuery:'  mal  '}),/no son válidos/);
  for(const name of ['a','z'.repeat(49),'Bad\u200bword',null]) {
    assert.throws(()=>normalizeReviewViewName(name),/inválido/);
  }
});
test('saved-views responses must be bounded and member-safe shape',()=>{
  const row={id:'some-id',name:'Inspección vencida',filters};
  assert.equal(validateSavedViews({data:[row]}).length,1);
  assert.deepEqual(validateSavedView({data:row}),row);
  assert.throws(()=>validateSavedViews({data:Array(11).fill(row)}),/no es válida/);
  assert.throws(()=>validateSavedView({data:{...row,filters:{...filters,tenantId:'private'}}}),/no son válidos/);
});
