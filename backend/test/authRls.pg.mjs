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

    const browserLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sedeagro-session': 'cookie',
        'x-sedeagro-request': '1'
      },
      body: JSON.stringify({ email, password, tenantSlug: slug })
    });
    const web = await browserLogin.json();
    assert.equal(browserLogin.status, 200, JSON.stringify(web));
    assert.equal(web.token, undefined, 'HttpOnly browser session must never expose JWT in JSON');
    assert.equal(web.tenant.id, tenantId);
    const cookies = browserLogin.headers.get('set-cookie');
    assert.match(cookies, /sedeagro_session=/);
    assert.match(cookies, /HttpOnly/);
    assert.match(cookies, /SameSite=Strict/);
    const cookie = cookies.split(';')[0];

    const browserMe = await fetch(`${baseUrl}/me`, {
      headers: { Cookie: cookie, 'x-tenant-id': tenantId }
    });
    assert.equal(browserMe.status, 200, await browserMe.text());
    const foreignId = randomUUID();
    const tenantMismatch = await fetch(`${baseUrl}/me`, {
      headers: { Cookie: cookie, 'x-tenant-id': foreignId }
    });
    assert.notEqual(tenantMismatch.status, 200, 'Cookie cannot cross tenant routing');
    const noCsrf = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'x-tenant-id': tenantId }
    });
    assert.equal(noCsrf.status, 403);
    const stillAlive = await fetch(`${baseUrl}/me`, {
      headers: { Cookie: cookie, 'x-tenant-id': tenantId }
    });
    assert.equal(stillAlive.status, 200, 'CSRF rejection must not revoke session');
    const logout = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'x-tenant-id': tenantId, 'x-sedeagro-request': '1' }
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    const revoked = await fetch(`${baseUrl}/me`, {
      headers: { Cookie: cookie, 'x-tenant-id': tenantId }
    });
    assert.equal(revoked.status, 401, 'Replay after logout must be rejected server-side');
    // Other sessions are independent; revoking this cookie must not revoke
    // the original bearer session issued on login.
    const bearerStillLive = await fetch(`${baseUrl}/me`, {
      headers: { Authorization: `Bearer ${login.token}`, 'x-tenant-id': tenantId }
    });
    assert.equal(bearerStillLive.status, 200);

    // Six independent logins, deliberately concurrent, must never exceed the
    // five-session cap even when the backend handles requests simultaneously.
    const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
      fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, tenantSlug: slug })
      }).then(async (res) => ({ status: res.status, body: await res.json() }))
    ));
    for (const attempt of concurrent) {
      assert.equal(attempt.status, 200, JSON.stringify(attempt.body));
    }
    const newestToken = concurrent[5].body.token;
    const current = await fetch(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${newestToken}`, 'x-tenant-id': tenantId }
    });
    assert.equal(current.status, 200);
    const listing = await current.json();
    assert.equal(listing.maxActiveSessions, 5);
    assert.equal(listing.data.length, 5, 'simultaneous logins must enforce the cap');
    assert.equal(listing.data.filter((row) => row.isCurrent).length, 1);
    assert.ok(listing.data.every((row) => !Object.hasOwn(row, 'token') &&
      !Object.hasOwn(row, 'password_hash')), 'session listing must expose no secrets');

    const stale = await fetch(`${baseUrl}/me`, {
      headers: { Authorization: `Bearer ${login.token}`, 'x-tenant-id': tenantId }
    });
    assert.equal(stale.status, 401, 'oldest session must have been revoked by cap');

    const another = listing.data.find((row) => !row.isCurrent);
    assert.ok(another, 'a remote session must be available to revoke');
    const csrfMissing = await fetch(`${baseUrl}/sessions/${another.id}`, {
      method: 'DELETE', headers: { Cookie: cookie, 'x-tenant-id': tenantId }
    });
    // The original browser session was logged out; it cannot revoke anyone.
    assert.equal(csrfMissing.status, 401);
    const self = listing.data.find((row) => row.isCurrent);
    const selfRevoke = await fetch(`${baseUrl}/sessions/${self.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${newestToken}`, 'x-tenant-id': tenantId }
    });
    assert.equal(selfRevoke.status, 409, 'current session requires explicit logout');
    const remoteRevoke = await fetch(`${baseUrl}/sessions/${another.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${newestToken}`, 'x-tenant-id': tenantId }
    });
    assert.equal(remoteRevoke.status, 204);
    const repeated = await fetch(`${baseUrl}/sessions/${another.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${newestToken}`, 'x-tenant-id': tenantId }
    });
    assert.equal(repeated.status, 404);
    const afterRevoke = await fetch(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${newestToken}`, 'x-tenant-id': tenantId }
    });
    assert.equal(afterRevoke.status, 200);
    assert.equal((await afterRevoke.json()).data.length, 4);

  } finally {
    if (tenantId) await owner.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    if (userId) await owner.query('DELETE FROM users WHERE id = $1', [userId]);
    await owner.end();
  }
});
