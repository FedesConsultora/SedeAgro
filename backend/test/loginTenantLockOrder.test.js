import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('tenant suspension and session issuance take the same row lock in consistent order', () => {
  const router = readFileSync(new URL('../src/modules/auth/router.js', import.meta.url),'utf8');
  const platform = readFileSync(new URL('../src/modules/platform/router.js', import.meta.url),'utf8');
  const issue = router.slice(router.indexOf('async function issueTenantSession'),
    router.indexOf('function finishLogin'));
  const status = platform.slice(platform.indexOf("platformRouter.patch('/tenants/:id'"),
    platform.indexOf('// GET tenant modules settings'));

  const tenantFind = issue.indexOf('const tenant = await Tenant.findOne');
  const tenantLock = issue.indexOf('lock: transaction.LOCK.UPDATE');
  const membershipFind = issue.indexOf('const currentMembership = await Membership.findOne');
  const membershipLock = issue.indexOf('lock: transaction.LOCK.UPDATE', membershipFind);
  const sessionReserve = issue.indexOf('await reserveSessionSlot');
  const sessionSign = issue.indexOf('const token = signSession');
  assert.ok(tenantFind>=0 && tenantFind<tenantLock && tenantLock<membershipFind &&
    membershipFind<membershipLock && membershipLock<sessionReserve &&
    sessionReserve<sessionSign,
  'Tenant FOR UPDATE must precede Membership FOR UPDATE and session issuance');
  assert.match(issue, /status: \{ \[Op\.in\]: \['onboarding', 'active'\] \}/);
  assert.match(issue, /LOGIN_TENANT_DISABLED/);
  assert.match(issue, /id: membership.tenant_id/);
  assert.match(issue, /tenant_id: tenant.id/);
  assert.match(status, /Tenant\.findByPk\(req\.params\.id/);
  assert.match(status, /lock: transaction\.LOCK\.UPDATE/);
  assert.match(status, /await AuthSession\.update/);
  assert.match(status, /await forTargetTenant\(req, tenant\.id/);
});

test('registration still sets transaction-local tenant context before session issuance', () => {
  const router = readFileSync(new URL('../src/modules/auth/router.js', import.meta.url),'utf8');
  const registration = router.slice(router.indexOf("authPublicRouter.post('/register-tenant'"),
    router.indexOf("authPublicRouter.post('/login'"));
  assert.ok(registration.indexOf('await setLocalTenant(transaction, tenant.id)') <
    registration.indexOf('return issueTenantSession(user, membership, transaction)'));
});
