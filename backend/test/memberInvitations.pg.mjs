// Real HTTP + disposable migrated PostGIS, non-owner runtime with FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.TEST_DATABASE_ADMIN_URL || !process.env.TEST_DATABASE_APP_URL) {
  throw new Error('memberInvitations.pg.mjs requires disposable PostGIS test DB URLs');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'member-invite-ci-only';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');
const { signSession } = await import('../src/utils/jwt.js');
const { hashPassword } = await import('../src/utils/password.js');

test('member invitations: tenant isolation, password ownership, expiry, revocation and replay', async t => {
  const owner = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  const appClient = new pg.Client({ connectionString: process.env.TEST_DATABASE_APP_URL });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerReady = false, appReady = false;
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/auth';
  async function api(path, { method = 'GET', token, tenantId, body } = {}) {
    const response = await fetch(base + path, {
      method, headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : null };
  }
  const inserted = async (sql, args) => (await owner.query(sql, args)).rows[0].id;
  try {
    await owner.connect(); ownerReady = true;
    await appClient.connect(); appReady = true;
    const db = (await owner.query('SELECT current_database() AS db')).rows[0].db;
    const role = (await appClient.query(`
      SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows[0];
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.ok(isSafeRuntimeDbRole(role), 'must use non-owner and FORCE RLS');
    const policy = (await owner.query(`
      SELECT relrowsecurity,relforcerowsecurity
      FROM pg_class WHERE oid='public.member_invitations'::regclass
    `)).rows[0];
    assert.equal(policy.relrowsecurity, true);
    assert.equal(policy.relforcerowsecurity, true);
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function tenant(tag) {
      const id = await inserted(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, 'Member invitation test ' + tag, 'member-invite-' + tag + '-' + suffix]);
      tenants.push(id); return id;
    }
    const a = await tenant('a'), b = await tenant('b');
    async function actor(tenantId, name, roleCode, password = 'fixture') {
      const email = name.replaceAll(' ', '') + '-' + suffix + '@example.test';
      const id = await inserted(
        "INSERT INTO users(email,full_name,password_hash) VALUES($1,$2,$3) RETURNING id",
        [email, name, password === 'fixture' ? password : await hashPassword(password)]);
      users.push(id);
      await owner.query("INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, id, roleCode]);
      return { id, email, password, token: signSession({
        sub: id, tenant_id: tenantId, role_code: roleCode
      }) };
    }
    const adminA = await actor(a, 'admin a', 'tenant_admin');
    const adminB = await actor(b, 'admin b', 'tenant_admin');
    const scoutA = await actor(a, 'scout a', 'scout');
    const invite = (identity, tenantId, email, roleCode = 'scout') => api('/invitations', {
      method: 'POST', token: identity.token, tenantId, body: { email, roleCode }
    });
    const email = 'new-' + suffix + '@example.test';
    assert.equal((await invite(scoutA, a, email)).status, 403);
    assert.equal((await invite(adminA, a, email, 'platform_admin')).status, 422);

    const issued = await invite(adminA, a, email);
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    assert.equal(issued.json.delivery.channel, 'manual');
    assert.equal(issued.json.delivery.delivered, false);
    const secret = issued.json.delivery.token;
    const id = issued.json.data.id;
    assert.ok(secret.startsWith(a + '.'));
    assert.equal((await invite(adminA, a, email)).status, 409);
    const listed = await api('/invitations', { token: adminA.token, tenantId: a });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.some(x => x.id === id), true);
    assert.equal(JSON.stringify(listed.json).includes(secret), false);
    assert.equal((await api('/invitations', { token: adminB.token, tenantId: b }))
      .json.data.some(x => x.id === id), false);
    assert.equal((await api('/invitations/' + id, {
      method: 'DELETE', token: adminB.token, tenantId: b
    })).status, 404);
    assert.equal((await api('/invitations', { token: scoutA.token, tenantId: a })).status, 403);

    const stored = (await owner.query(
      'SELECT token_hash,role_code,status FROM member_invitations WHERE id=$1', [id]
    )).rows[0];
    assert.equal(stored.role_code, 'scout');
    assert.equal(stored.status, 'pending');
    assert.notEqual(stored.token_hash, secret);
    assert.equal(stored.token_hash.length, 64);

    // An opaque secret with a valid tenant prefix still grants no authority.
    assert.equal((await api('/invite/accept', { method: 'POST', body: {
      token: a + '.' + 'a'.repeat(64), password: 'SafePassword903', fullName: 'New Scout'
    } })).status, 404);
    assert.equal((await api('/invite/accept', { method: 'POST', body: {
      token: secret, password: 'weak', fullName: 'New Scout'
    } })).status, 422);
    const accepted = await api('/invite/accept', { method: 'POST', body: {
      token: secret, password: 'StrongTesting903', fullName: 'New Scout'
    } });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    assert.equal(accepted.json.data.roleCode, 'scout');
    assert.equal(accepted.json.data.tenant.id, a);
    const replay = await api('/invite/accept', { method: 'POST', body: {
      token: secret, password: 'StrongTesting903', fullName: 'New Scout'
    } });
    assert.equal(replay.status, 410);
    const login = await api('/login', { method: 'POST', body: {
      email, password: 'StrongTesting903', tenantId: a
    } });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    assert.equal(login.json.membership.roleCode, 'scout');
    const userId = login.json.user.id;
    const active = (await owner.query(
      "SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
      [a, userId]
    )).rows[0].n;
    assert.equal(active, 1);
    users.push(userId);

    // Revoked tokens never activate the account or leak a credential.
    const revokedEmail = 'revoked-' + suffix + '@example.test';
    const issued2 = await invite(adminA, a, revokedEmail, 'contractor');
    assert.equal(issued2.status, 201);
    const revoked = await api('/invitations/' + issued2.json.data.id, {
      method: 'DELETE', token: adminA.token, tenantId: a
    });
    assert.equal(revoked.status, 204);
    const afterRevoke = await api('/invite/accept', { method: 'POST', body: {
      token: issued2.json.delivery.token, password: 'SafePassword903',
      fullName: 'Revoked Contractor'
    } });
    assert.equal(afterRevoke.status, 410);

    // Multiempresa existing users retain their own password. An invite cannot
    // overwrite another account's credentials or transfer memberships silently.
    const existingPassword = 'ExistingTester938';
    const existing = await actor(a, 'existing a', 'contractor', existingPassword);
    const foreign = await invite(adminB, b, existing.email, 'scout');
    assert.equal(foreign.status, 201, JSON.stringify(foreign.json));
    const foreignSecret = foreign.json.delivery.token;
    const wrong = await api('/invite/accept', { method: 'POST', body: {
      token: foreignSecret, password: 'IncorrectPassword119'
    } });
    assert.equal(wrong.status, 422);
    const good = await api('/invite/accept', { method: 'POST', body: {
      token: foreignSecret, password: existingPassword
    } });
    assert.equal(good.status, 201, JSON.stringify(good.json));
    assert.equal(good.json.data.tenant.id, b);
    assert.equal((await owner.query(
      'SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND user_id=$2',
      [b, existing.id])).rows[0].n, 1);

    // Expired bearer tokens must fail without creating a new user. The
    // expired pending email is then reusable for a completely new secret.
    const expiredEmail = 'expired-' + suffix + '@example.test';
    const expiring = await invite(adminA, a, expiredEmail);
    assert.equal(expiring.status, 201, JSON.stringify(expiring.json));
    await owner.query(
      "UPDATE member_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expiring.json.data.id]);
    const past = await api('/invite/accept', { method: 'POST', body: {
      token: expiring.json.delivery.token, password: 'FreshStrongPassword903', fullName: 'Expired'
    } });
    assert.equal(past.status, 410);
    const reissued = await invite(adminA, a, expiredEmail);
    assert.equal(reissued.status, 201, JSON.stringify(reissued.json));
    assert.notEqual(reissued.json.data.id, expiring.json.data.id);

    // Concurrent acceptance must serialize on tenant/invitation row and not
    // produce duplicate credentials, members or two successful responses.
    const raceEmail = 'race-' + suffix + '@example.test';
    const raceInvite = await invite(adminA, a, raceEmail);
    assert.equal(raceInvite.status, 201, JSON.stringify(raceInvite.json));
    const raceBody = { token: raceInvite.json.delivery.token,
      password: 'ConcurrentTesting903', fullName: 'Concurrent Scout' };
    const races = await Promise.all([
      api('/invite/accept', { method: 'POST', body: raceBody }),
      api('/invite/accept', { method: 'POST', body: raceBody })
    ]);
    assert.deepEqual(races.map(x => x.status).sort(), [201, 410], JSON.stringify(races));
    const racedUsers = (await owner.query('SELECT id FROM users WHERE email=$1', [raceEmail])).rows;
    assert.equal(racedUsers.length, 1);
    users.push(racedUsers[0].id);
    assert.equal((await owner.query(
      'SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND user_id=$2',
      [a, racedUsers[0].id])).rows[0].n, 1);
    const auditRows = (await owner.query(
      'SELECT before,after FROM audit_events WHERE entity_id=$1',
      [raceInvite.json.data.id])).rows;
    assert.equal(auditRows.length, 2);
    assert.equal(JSON.stringify(auditRows).includes(raceInvite.json.delivery.token), false);

    // A tiny test-only plan proves outstanding invitations reserve seats.
    // Do not change the globally seeded starter plan or production billing.
    const tinyPlan = await inserted(
      "INSERT INTO plans(code,name,max_users) VALUES($1,'Invitation capacity test',2) RETURNING id",
      ['invite-capacity-' + suffix]);
    const smallTenant = await inserted(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
      [tinyPlan, 'Invitation capacity test', 'invite-capacity-' + suffix]);
    tenants.push(smallTenant);
    const smallAdmin = await actor(smallTenant, 'admin capacity', 'tenant_admin');
    const firstSlot = await invite(smallAdmin, smallTenant,
      'first-capacity-' + suffix + '@example.test');
    assert.equal(firstSlot.status, 201, JSON.stringify(firstSlot.json));
    const noSlot = await invite(smallAdmin, smallTenant,
      'second-capacity-' + suffix + '@example.test');
    assert.equal(noSlot.status, 409, JSON.stringify(noSlot.json));
    assert.equal(noSlot.json.error.code, 'MEMBER_SEATS_FULL');
    // Revocation must free that reserved slot in the same transaction.
    const revokeSlot = await api('/invitations/' + firstSlot.json.data.id, {
      method: 'DELETE', token: smallAdmin.token, tenantId: smallTenant
    });
    assert.equal(revokeSlot.status, 204);
    assert.equal((await invite(smallAdmin, smallTenant,
      'second-capacity-' + suffix + '@example.test')).status, 201);

    // Per-tenant RLS reads use the runtime role, not the owner connection.
    await appClient.query('BEGIN');
    try {
      await appClient.query("SELECT set_config('app.current_tenant',$1,true)", [b]);
      const foreignRows = (await appClient.query(
        'SELECT id FROM member_invitations WHERE id=$1', [id]
      )).rows;
      assert.deepEqual(foreignRows, []);
      await appClient.query('ROLLBACK');
    } catch (e) {
      await appClient.query('ROLLBACK'); throw e;
    }
  } finally {
    if (ownerReady) {
      try {
        if (tenants.length) await owner.query(
          'DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query(
          'DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
        await owner.query('DELETE FROM plans WHERE code=$1', ['invite-capacity-' + suffix]);
      } finally { await owner.end(); }
    }
    if (appReady) await appClient.end();
  }
});
