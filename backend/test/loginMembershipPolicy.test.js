import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectLoginMembership } from '../src/modules/auth/loginMembershipPolicy.js';

const a={id:'mem-a',tenant_id:'tenant-a',role_code:'tenant_admin',
  status:'active',Tenant:{slug:'empresa-a',status:'active'}};
const b={id:'mem-b',tenant_id:'tenant-b',role_code:'scout',
  status:'active',Tenant:{slug:'empresa-b',status:'active'}};

test('both selectors must identify the same authorized company', () => {
  assert.equal(selectLoginMembership([a,b],{tenantId:'tenant-a',tenantSlug:'empresa-a'}),a);
  assert.equal(selectLoginMembership([a,b],{tenantId:'tenant-b',tenantSlug:'empresa-b'}),b);
  assert.equal(selectLoginMembership([a,b],{tenantId:'tenant-a'}),a);
  assert.equal(selectLoginMembership([a,b],{tenantSlug:'empresa-b'}),b);
  assert.equal(selectLoginMembership([a,b],{tenantId:'tenant-a',tenantSlug:'empresa-b'}),null);
  assert.equal(selectLoginMembership([a,b],{tenantId:'tenant-b',tenantSlug:'empresa-a'}),null);
  assert.equal(selectLoginMembership([a,b],{tenantId:'tenant-a',tenantSlug:'no-existe'}),null);
  assert.equal(selectLoginMembership([a,b],{tenantId:'tenant-c'}),null);
  assert.equal(selectLoginMembership([a,b],{}),null);
  assert.equal(selectLoginMembership([a],{}),a);
  assert.equal(selectLoginMembership([],{tenantId:'tenant-a'}),null);
  assert.equal(selectLoginMembership(null,{}),null);
});

test('login never issues stale membership role or uses tenant OR matching', () => {
  const router=readFileSync(new URL('../src/modules/auth/router.js',import.meta.url),'utf8');
  const issue=router.slice(router.indexOf('async function issueTenantSession'),
    router.indexOf('function finishLogin'));
  const selection=router.slice(router.indexOf("authPublicRouter.post('/login'"),
    router.indexOf("authScopedRouter.post('/logout'"));
  const companyLock=issue.indexOf('lock: transaction.LOCK.UPDATE');
  const before=issue.indexOf('const currentMembership = await Membership.findOne');
  const locked=issue.indexOf('lock: transaction.LOCK.UPDATE', before);
  const reserve=issue.indexOf('await reserveSessionSlot');
  const sign=issue.indexOf('const token = signSession');
  assert.ok(companyLock>=0 && companyLock<before &&
    before<locked && locked<reserve && reserve<sign);
  for(const expected of [
    "id: membership.id","tenant_id: tenant.id","user_id: user.id",
    "status: 'active'","tenantId: currentMembership.tenant_id",
    'sessionPayload(user, currentMembership)',
    'roleCode: currentMembership.role_code'
  ]) assert.ok(issue.includes(expected), 'missing selected membership revalidation: '+expected);
  assert.match(selection,/selectLoginMembership\(activeMemberships, \{ tenantId, tenantSlug \}\)/);
  assert.match(selection,/LOGIN_TENANT_NOT_AVAILABLE/);
  assert.doesNotMatch(selection,/\.tenant_id === tenantId \|\|/);
});

test('tenant registration installs GUC before writing membership and entitlements', () => {
  const router=readFileSync(new URL('../src/modules/auth/router.js',import.meta.url),'utf8');
  const registration=router.slice(router.indexOf("authPublicRouter.post('/register-tenant'"),
    router.indexOf("authPublicRouter.post('/login'"));
  const tenant=registration.indexOf('const tenant = await Tenant.create');
  const scope=registration.indexOf('await setLocalTenant(transaction, tenant.id)');
  const membership=registration.indexOf('const membership = await Membership.create');
  const entitlements=registration.indexOf('await TenantModule.bulkCreate');
  assert.ok(tenant>=0 && scope>tenant && membership>scope && entitlements>membership);
  assert.equal(registration.match(/await setLocalTenant\(transaction, tenant.id\)/g)?.length,1);
});
