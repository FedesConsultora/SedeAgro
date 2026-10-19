import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_VIEW_LIMIT, parseReviewView, isValidSavedReviewView, publicReviewView, SHARED_REVIEW_VIEW_LIMIT
} from '../src/modules/workOrders/reviewQueueSavedViews.js';

const defaults = Object.freeze({ workType:'all', reviewState:'all',
  priority:'all', dueWindow:'all', titleQuery:'', sortMode:'newest' });

test('view accepts only bounded explicit filter schema and normalized name', () => {
  assert.equal(REVIEW_VIEW_LIMIT,10);
  assert.deepEqual(parseReviewView({name:'  Urgentes   de hoy  ',filters:defaults}),
    {name:'Urgentes de hoy',filters:defaults});
  assert.equal(parseReviewView({name:'Café',filters:{...defaults,titleQuery:'Café'}})
    .filters.titleQuery,'Café');
  for(const invalid of [
    {name:'A',filters:defaults},{name:'A'.repeat(49),filters:defaults},
    {name:'abc\u200b',filters:defaults},{name:'Valid name',filters:{...defaults,sortMode:'evil'}},
    {name:'Valid name',filters:{...defaults,titleQuery:' unclean'}},
    {name:'Valid name',filters:{...defaults,role:'tenant_admin'}},
    {name:'Valid name',filters:defaults,cursor:'fake'},
    {name:'Valid name',filters:{...defaults,workType:[]}}
  ]) assert.throws(()=>parseReviewView(invalid),/inválida/);
  assert.equal(SHARED_REVIEW_VIEW_LIMIT,20);
  assert.equal(isValidSavedReviewView({id:'uuid',name:'Test',
    visibility:'private',filters:defaults}),true);
  assert.equal(isValidSavedReviewView({id:'uuid',name:'Test',
    filters:{...defaults,cursor:'not allowed'}}),false);
});

test('public projection returns only safe filters, visibility and ownership marker',()=>{
  const record={id:'one',name:'Vencidas',filters:defaults,visibility:'shared',
    tenant_id:'private-company',user_id:'admin-id',
    created_at:'2026-10-19',updated_at:'2026-10-19'};
  const owned=publicReviewView(record,'admin-id');
  const other=publicReviewView(record,'coordinator-id');
  assert.equal(owned.source,'mine');
  assert.equal(other.source,'shared');
  assert.equal(other.visibility,'shared');
  assert.deepEqual(Object.keys(other).sort(),
    ['created_at','filters','id','name','source','updated_at','visibility']);
  assert.equal(isValidSavedReviewView({...record,visibility:'exposed'}),false);
});
