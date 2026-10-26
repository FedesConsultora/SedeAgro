import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  memberLifecycleAuthority, canManageMember, prepareMemberStatus,
  confirmMemberStatus
} from '../src/services/memberLifecycleSafety.js';

const tid='11111111-1111-4111-8111-111111111111';
const uid='22222222-2222-4222-8222-222222222222';
const mid='33333333-3333-4333-8333-333333333333';
const sid='44444444-4444-4444-8444-444444444444';
const member={ id:mid, tenant_id:tid, user_id:sid, role_code:'scout', status:'active' };
const session={ authenticated:true, tenant:{id:tid},user:{id:uid},
  membership:{id:'55555555-5555-4555-8555-555555555555',roleCode:'tenant_admin'},
  entitlements:['org'] };

test('only real admin, matching tenant and non-admin target can mutate member status',()=>{
  assert.ok(memberLifecycleAuthority(session,'live'));
  assert.equal(canManageMember(member,session,'live'),true);
  for(const bad of [
    { ...member,tenant_id:uid },
    { ...member,user_id:uid },
    { ...member,role_code:'tenant_admin' },
    { ...member,status:'pending' },
    { ...member,id:'not-uuid' }
  ])assert.equal(canManageMember(bad,session,'live'),false);
  assert.equal(canManageMember(member,session,'mock'),false);
  assert.equal(canManageMember(member,{...session,membership:{...session.membership,roleCode:'scout'}},'live'),false);
});
test('HTTP status receipt binds actor-selected member and desired status exactly',()=>{
  const expected=prepareMemberStatus(member,'blocked',session,'live');
  const response={data:{id:mid,tenant_id:tid,user_id:sid,role_code:'scout',
    status:'blocked',changed:true}};
  assert.equal(confirmMemberStatus(response,expected).status,'blocked');
  for (const patch of [
    {tenant_id:uid},{user_id:uid},{role_code:'tenant_admin'},
    {status:'active'},{changed:'true'}
  ])assert.throws(()=>confirmMemberStatus({data:{...response.data,...patch}},expected),
    /No se confirmó/);
  assert.throws(()=>prepareMemberStatus(member,'active',session,'live'),/permitido/);
});
test('live member view distinguishes tenant membership status and requires exact server ACK',()=>{
  const source=readFileSync(new URL('../src/pages/TeamPage.jsx',import.meta.url),'utf8');
  assert.match(source,/member\.status === 'active'/);
  assert.match(source,/prepareMemberStatus\(member, target, session, dataMode\)/);
  assert.match(source,/confirmMemberStatus\(response, operation\)/);
  assert.match(source,/scopeRef\.current === requestScope/);
  assert.match(source,/apiRef\.current === requestApi/);
});
