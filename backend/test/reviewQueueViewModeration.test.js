import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRevokeSharedView, publicModeratedSharedView, publicModerationEvent,
  REVIEW_VIEW_MODERATION_AUDIT_PAGE_SIZE
} from '../src/modules/workOrders/reviewQueueViewModeration.js';

test('moderator reason is normalized, required and bounded by code points',()=>{
  assert.equal(REVIEW_VIEW_MODERATION_AUDIT_PAGE_SIZE,50);
  assert.deepEqual(parseRevokeSharedView({reason:'  Vista  obsoleta  '}),{reason:'Vista obsoleta'});
  for (const invalid of [null,{}, {reason:''},{reason:'corta'},
    {reason:'x'.repeat(201)},{reason:'texto\u200b invisible'},
    {reason:'Es válida',viewId:'forged'},{reason:[]},
    {reason:'Vista obsoleta',action:'share'}]) {
    assert.throws(()=>parseRevokeSharedView(invalid),/inválido/);
  }
});
test('moderation responses do not leak saved filters or tenant metadata',()=>{
  const row={id:'id',name:'Para todos',created_at:'today',publisher_active:true,
    filters:{titleQuery:'private'},tenant_id:'tenant',user_id:'owner'};
  assert.deepEqual(publicModeratedSharedView(row),
    {id:'id',name:'Para todos',created_at:'today',publisher_active:true});
  const event={id:'audit',view_id:'id',view_name:'Para todos',actor_user_id:'actor',
    view_owner_id:'owner',reason:'Vista obsoleta',action:'revoke_share',
    created_at:'now',filters:{secret:'x'},tenant_id:'tenant'};
  assert.deepEqual(publicModerationEvent(event),{
    id:'audit',view_id:'id',view_name:'Para todos',actor_user_id:'actor',
    view_owner_id:'owner',reason:'Vista obsoleta',action:'revoke_share',
    created_at:'now'
  });
});
