// Regression test for FORCE RLS on tenant_modules in public registration and login.
// Execute only in a disposable migrated PostgreSQL *_test database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) {
  throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_APP_URL for a disposable test database.');
}
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'not-for-production-rls-integration-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { Client } = pg;

test('registration and login return real enabled modules under FORCE RLS', async (t) => {
  const owner = new Client({ connectionString: adminUrl });
  const random = randomUUID().replaceAll('-', '').slice(0, 12);
  const slug = `rls-auth-${random}`;
  const email = `owner-${random}@example.test`;
  const password = 'StrongCI-Password-2026!';
  let userId;
  let tenantId;

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sequelize.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/auth`;

  await owner.connect();
  try {
    const { rows: [{ name }] } = await owner.query('SELECT current_database() AS name');
    assert.match(name, /(?:^|[_-])test(?:$|[_-])/i,
      'Refusing to test registration in a non-test database');

    const response = await fetch(`${baseUrl}/register-tenant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationName: 'RLS Registration Example',
        slug,
        fullName: 'RLS Test Owner',
        email,
        password
      })
    });
    const registered = await response.json();
    assert.equal(response.status, 201, JSON.stringify(registered));
    userId = registered.user.id;
    tenantId = registered.tenant.id;
    assert.ok(registered.token, 'registration must return a signed session');
    assert.ok(registered.entitlements.includes('org'), 'registration must return org entitlement');
    assert.ok(registered.entitlements.includes('gis'), 'registration must return GIS entitlement');

    const loginResponse = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, tenantSlug: slug })
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200, JSON.stringify(login));
    assert.equal(login.tenant.id, tenantId);
    assert.deepEqual([...login.entitlements].sort(), [...registered.entitlements].sort());
    assert.ok(login.token, 'login must return a session');

    const scoped = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${login.token}`, 'x-tenant-id': tenantId }
    });
    const profile = await scoped.json();
    assert.equal(scoped.status, 200, JSON.stringify(profile));
    assert.deepEqual([...profile.entitlements].sort(), [...registered.entitlements].sort());
  } finally {
    if (tenantId) await owner.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    if (userId) await owner.query('DELETE FROM users WHERE id = $1', [userId]);
    await owner.end();
  }
});
