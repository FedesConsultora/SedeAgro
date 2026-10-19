import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_MODERATION_PATH, MODERATION_AUDIT_LIMIT,
  normalizeModerationReason,validateModerationInventory,
  validateModerationAudit,validateModerationRevoke
} from '../src/services/reviewQueueViewModeration.js';

const view={id:'one',name:'Compartida',created_at:'now',publisher_active:false};
const event={id:'event',view_id:'one',view_name:'Compartida',
  actor_user_id:'actor',view_owner_id:'owner',reason:'Vista obsoleta',
  action:'revoke_share',created_at:'now'};
test('moderation reasons are canonical and bounded',()=>{
  assert.equal(REVIEW_MODERATION_PATH,'/work-orders/review-queue/views/moderation');
  assert.equal(normalizeModerationReason('  Vista   obsoleta  '),'Vista obsoleta');
  for (const reason of ['corta','a'.repeat(201),'texto\u200b invisible',null])
    assert.throws(()=>normalizeModerationReason(reason),/inválido/);
});
test('admin-only inventory never accepts filters or tenant/user detail',()=>{
  assert.deepEqual(validateModerationInventory({data:[view]}),[view]);
  assert.throws(()=>validateModerationInventory({data:[{...view,filters:{}}]}),/inválido/);
  assert.throws(()=>validateModerationInventory({data:[view,view]}),/inválido/);
  assert.throws(()=>validateModerationInventory({data:Array(21).fill(null)}),/inválido/);
});
test('audit must be bounded, append-only revoke shape with no shared query values',()=>{
  assert.equal(MODERATION_AUDIT_LIMIT,50);
  assert.deepEqual(validateModerationAudit({data:[event],page_size:50}),[event]);
  assert.deepEqual(validateModerationRevoke({data:event}),event);
  assert.throws(()=>validateModerationAudit({data:[event],page_size:100}),/inválido/);
  assert.throws(()=>validateModerationRevoke({data:{...event,filters:{secret:'x'}}}),/inválida/);
  assert.throws(()=>validateModerationRevoke({data:{...event,action:'publish'}}),/inválida/);
});
