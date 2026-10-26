import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planTenantStatusChange } from '../src/modules/platform/tenantStatusPolicy.js';

const base={actorTenantId:'tenant-home',targetTenantId:'tenant-other',previousStatus:'active'};
test('platform tenant suspension forbids self lockout and deletion resurrection',()=>{
  assert.deepEqual(planTenantStatusChange({...base,nextStatus:'suspended'}),{
    allowed:true,revokeSessions:true,statusChanged:true
  });
  assert.deepEqual(planTenantStatusChange({...base,nextStatus:'deleted'}),{
    allowed:true,revokeSessions:true,statusChanged:true
  });
  assert.deepEqual(planTenantStatusChange({...base,previousStatus:'suspended',nextStatus:'active'}),{
    allowed:true,revokeSessions:false,statusChanged:true
  });
  assert.deepEqual(planTenantStatusChange({...base,previousStatus:'suspended',nextStatus:'suspended'}),{
    allowed:true,revokeSessions:true,statusChanged:false
  });
  assert.deepEqual(planTenantStatusChange({...base,nextStatus:undefined}),{
    allowed:true,revokeSessions:false,statusChanged:false
  });
  assert.deepEqual(planTenantStatusChange({...base,targetTenantId:base.actorTenantId,nextStatus:'suspended'}),{
    allowed:false,code:'TENANT_SELF_LOCKOUT_FORBIDDEN'
  });
  assert.deepEqual(planTenantStatusChange({...base,targetTenantId:base.actorTenantId,nextStatus:'deleted'}),{
    allowed:false,code:'TENANT_SELF_LOCKOUT_FORBIDDEN'
  });
  assert.deepEqual(planTenantStatusChange({...base,previousStatus:'deleted',nextStatus:'active'}),{
    allowed:false,code:'TENANT_DELETED_TERMINAL'
  });
  assert.deepEqual(planTenantStatusChange({...base,previousStatus:'deleted',nextStatus:undefined,planChangeRequested:true}),{
    allowed:false,code:'TENANT_DELETED_TERMINAL'
  });
  assert.deepEqual(planTenantStatusChange({...base,nextStatus:'invalid'}),{
    allowed:false,code:'TENANT_STATUS_INVALID'
  });
});

test('platform update locks tenant and revokes matching sessions before ACK, retaining FORCE RLS',()=>{
  const source=readFileSync(new URL('../src/modules/platform/router.js',import.meta.url),'utf8');
  const patch=source.slice(source.indexOf("platformRouter.patch('/tenants/:id'"),
    source.indexOf("// GET tenant modules settings"));
  const lock=patch.indexOf('lock: transaction.LOCK.UPDATE');
  const update=patch.indexOf('await tenant.update(parsed');
  const revoke=patch.indexOf('await AuthSession.update');
  const audit=patch.indexOf('await PlatformAuditLog.create');
  const reply=patch.indexOf('res.json({ data: tenant, changed, revokedSessions });');
  assert.ok(lock>=0&&update>lock&&revoke>update&&audit>revoke&&reply>audit);
  assert.match(patch,/forTargetTenant\(req, tenant.id/);
  assert.match(patch,/where: \{ tenant_id: tenant.id, revoked_at: null \}/);
  assert.match(patch,/planTenantStatusChange\(/);
  assert.match(patch,/private, no-store/);
  assert.match(patch,/platform.tenant.lifecycle_updated/);
  assert.match(patch,/tenant_id: tenant.id/);
  assert.match(patch,/skipTenantScope: true\s*\}\);\s*\}\s*res.setHeader/,
    'platform audit must not be reassigned to actor home tenant by ALS hooks');
  assert.match(source,/if \(tenantId === req.tenantId\) return operation\(\)/);
  assert.match(source,/finally \{\s*await setLocalTenant\(req.dbTransaction, req.tenantId\)/);
});
