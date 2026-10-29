import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Op } from 'sequelize';
import {
  MAX_LOGIN_DISCOVERY_TENANTS, loginDiscoveryTenantWhere
} from '../src/modules/auth/loginMembershipDiscovery.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('public login discovery candidates never include disabled companies', () => {
  const def = loginDiscoveryTenantWhere();
  assert.deepEqual(def.status[Op.in], ['onboarding', 'active']);
  assert.equal(def.id, undefined);
  assert.equal(def.slug, undefined);
  assert.deepEqual(loginDiscoveryTenantWhere({
    tenantId: 'a', tenantSlug: 'b'
  }).status[Op.in], ['onboarding', 'active']);
  const selected = loginDiscoveryTenantWhere({ tenantId: 'a', tenantSlug: 'b' });
  assert.equal(selected.id, 'a');
  assert.equal(selected.slug, 'b');
  assert.equal(MAX_LOGIN_DISCOVERY_TENANTS, 250);
});

test('no login bypass, unbounded company list or unconditional public SELECT on memberships', () => {
  const auth = source('../src/modules/auth/router.js');
  const discovery = source('../src/modules/auth/loginMembershipDiscovery.js');
  const migration = source('../db/migrations/202610290002_memberships_force_rls.js');
  const start = auth.indexOf("authPublicRouter.post('/login'");
  assert.ok(start >= 0);
  const end = auth.indexOf("authScopedRouter.post('/logout'", start);
  const route = auth.slice(start, end);
  assert.ok(route.indexOf('verifyPassword(password, user.password_hash)') <
    route.indexOf('discoverLoginMemberships(user.id'));
  assert.doesNotMatch(route, /Membership\.findAll/);
  assert.match(discovery, /limit: explicit \? 1 : MAX_LOGIN_DISCOVERY_TENANTS \+ 1/);
  assert.match(discovery, /throw new HttpError\(503/);
  assert.match(discovery, /return sequelize\.transaction\(async transaction =>/);
  assert.match(discovery, /await setLocalTenant\(transaction, tenant.id\)/);
  assert.match(discovery, /Membership\.findOne\(/);
  assert.match(discovery, /tenant_id: tenant.id, user_id: userId, status: 'active'/);
  assert.match(discovery, /attributes: \['id', 'tenant_id', 'user_id', 'role_code', 'status'\]/);
  assert.doesNotMatch(discovery, /BYPASSRLS|SECURITY DEFINER|set_config\(|skipTenantScope:\s*false/);
  assert.match(migration, /ALTER TABLE memberships ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE memberships FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /USING \(tenant_id = app\.current_tenant_id\(\)\)/);
  assert.match(migration, /WITH CHECK \(tenant_id = app\.current_tenant_id\(\)\)/);
});

test('session issuance still rechecks selected membership under a real row lock', () => {
  const auth = source('../src/modules/auth/router.js');
  assert.match(auth, /async function issueTenantSession\(/);
  assert.match(auth, /const currentMembership = await Membership\.findOne/);
  assert.match(auth, /lock: transaction\.LOCK\.UPDATE/);
  assert.match(auth, /where: \{\s*id: membership\.id,\s*tenant_id: tenant\.id,\s*user_id: user\.id,\s*status: 'active'/);
  assert.match(auth, /withTenantTransaction\(/);
  assert.doesNotMatch(auth, /skipTenantScope:\s*true\s*\}\);\s*const currentMembership/);
});
