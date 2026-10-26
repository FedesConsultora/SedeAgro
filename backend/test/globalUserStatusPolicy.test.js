import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { globalUserStatusDecision } from '../src/modules/platform/globalUserStatusPolicy.js';

const actor = { id:'10000000-0000-4000-8000-000000000001', is_platform_admin:true };
const member = { id:'20000000-0000-4000-8000-000000000002',
  is_platform_admin:false, status:'active' };

test('platform suspension only applies to non-admin account and non-deleted status', () => {
  assert.deepEqual(globalUserStatusDecision(actor,member,'blocked'),{
    allowed:true,changed:true
  });
  assert.deepEqual(globalUserStatusDecision(actor,{...member,status:'blocked'},'active'),{
    allowed:true,changed:true
  });
  assert.deepEqual(globalUserStatusDecision(actor,{...member,status:'blocked'},'blocked'),{
    allowed:true,changed:false
  });
  for(const [a,target,next,code] of [
    [null,member,'blocked','PLATFORM_USER_STATUS_FORBIDDEN'],
    [{...actor,is_platform_admin:false},member,'blocked','PLATFORM_USER_STATUS_FORBIDDEN'],
    [actor,{...member,id:actor.id},'blocked','PLATFORM_ADMIN_PROTECTED'],
    [actor,{...member,is_platform_admin:true},'blocked','PLATFORM_ADMIN_PROTECTED'],
    [actor,{...member,status:'deleted'},'active','PLATFORM_USER_DELETED'],
    [actor,{...member,status:'pending'},'blocked','PLATFORM_USER_STATUS_UNSUPPORTED'],
    [actor,member,'deleted','PLATFORM_USER_STATUS_INVALID']
  ]) {
    assert.deepEqual(globalUserStatusDecision(a,target,next),{allowed:false,code});
  }
});

test('global suspension locks user, revokes by tenant RLS and resets original scope before ACK', () => {
  const source = readFileSync(new URL('../src/modules/platform/globalUserLifecycle.js',import.meta.url),'utf8');
  const router = readFileSync(new URL('../src/modules/platform/router.js',import.meta.url),'utf8');
  const lock = source.indexOf('lock: transaction.LOCK.UPDATE');
  const mutate = source.indexOf('await target.update');
  const revoke = source.indexOf('await AuthSession.update');
  const reset = source.indexOf('await setLocalTenant(transaction, req.tenantId)');
  const reply = source.indexOf('res.json({ data:');
  assert.ok(lock >= 0 && mutate > lock && revoke > mutate && reset > revoke && reply > reset);
  assert.match(source,/globalUserStatusDecision\(req\.auth\.user, target, req\.body\.status\)/);
  assert.match(source,/Tenant\.findAll\(/);
  assert.doesNotMatch(source,/Membership\.findAll\(/,
    'must revoke orphaned JWT sessions from tenants without a current membership');
  assert.match(source,/await setLocalTenant\(transaction, tenantId\)/);
  assert.match(source,/where: \{ tenant_id: tenantId, user_id: target\.id, revoked_at: null \}/);
  assert.match(source,/PlatformAuditLog\.create\(/);
  assert.match(source,/private, no-store/);
  assert.match(source,/!isPlatformAdministrator\(req\.auth\)/);
  assert.match(router,/platformRouter\.use\('\/users', globalUserLifecycleRouter\)/);
});
