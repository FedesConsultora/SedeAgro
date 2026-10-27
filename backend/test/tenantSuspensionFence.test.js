import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('transaction-scoped shared/exclusive advisory locks share one tenant namespace',()=>{
  const source=read('../src/core/tenantSuspensionFence.js');
  assert.match(source, /pg_advisory_xact_lock_shared\(hashtext\(:namespace\), hashtext\(:tenantId\)\)/);
  assert.match(source, /pg_advisory_xact_lock\(hashtext\(:namespace\), hashtext\(:tenantId\)\)/);
  assert.match(source,/assertTenantTransaction\(transaction, tenantId\)/);
  assert.match(source,/LOCK_NAMESPACE = 'sedeagro-pilot-tenant-status-v1'/);
  assert.doesNotMatch(source,/pg_advisory_lock\(/,
    'no session-scoped locks may leak into reused pool connections');
});
test('scoped request rechecks tenant status inside its guarded transaction before auth',()=>{
  const m=read('../src/infra/http/middlewares/tenantTransaction.js');
  const app=read('../src/app.js');
  const tx=m.indexOf('transaction = await sequelize.transaction()');
  const fence=m.indexOf("await lockTenantLifecycle(transaction, req.tenantId, 'shared')");
  const guc=m.indexOf('await setLocalTenant(transaction, req.tenantId)');
  const find=m.indexOf('const liveTenant = await Tenant.findOne');
  const fail=m.indexOf('TENANT_DISABLED_DURING_REQUEST');
  const next=m.lastIndexOf('next()');
  assert.ok(tx>=0&&tx<fence&&fence<guc&&guc<find&&find<fail&&fail<next);
  assert.match(m,/where: \{ id: req\.tenantId, status:/);
  assert.match(m,/transaction, skipTenantScope: true/);
  assert.ok(app.indexOf('app.use(tenantResolver)') < app.indexOf('app.use(tenantTransaction)'));
  assert.ok(app.indexOf('app.use(tenantTransaction)') < app.indexOf('mountScopedRoutes(app'));
});
test('platform tenant status holds exclusive lock before UPDATE and revoke, preserving self guard',()=>{
  const platform=read('../src/modules/platform/router.js');
  const policy=read('../src/modules/platform/tenantStatusPolicy.js');
  const patch=platform.slice(platform.indexOf("platformRouter.patch('/tenants/:id'"),
    platform.indexOf('// GET tenant modules settings'));
  const exclusive=patch.indexOf("await lockTenantLifecycle(transaction, req.params.id, 'exclusive')");
  const updateLock=patch.indexOf('lock: transaction.LOCK.UPDATE');
  const update=patch.indexOf('await tenant.update(parsed');
  const revoke=patch.indexOf('await AuthSession.update');
  const reply=patch.indexOf('res.json({ data: tenant, changed, revokedSessions });');
  assert.ok(exclusive>=0&&updateLock>exclusive&&update>updateLock&&revoke>update&&reply>revoke);
  assert.match(patch,/req\.params\.id !== req\.tenantId && parsed\.status !== undefined/);
  assert.match(policy,/TENANT_SELF_LOCKOUT_FORBIDDEN/);
});
