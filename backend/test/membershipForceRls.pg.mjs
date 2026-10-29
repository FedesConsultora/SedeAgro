// Real PostgreSQL non-owner proof: membership rows have FORCE RLS even
// when no tenant was selected yet; login multiempresa remains functional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('membershipForceRls requires disposable *_test PostGIS URLs');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'memberships-force-rls-ci-only';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { hashPassword } = await import('../src/utils/password.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('FORCE RLS prevents global membership reads/writes and supports two-company login', async t => {
  const owner = new pg.Client({ connectionString: adminUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerReady = false, runtimeReady = false;
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/auth';
  const password = 'MembershipForceRls2026Secure!';
  const create = async (q, params) => (await owner.query(q, params)).rows[0].id;
  const login = async (email, body = {}) => {
    const response = await fetch(url + '/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, ...body })
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await owner.connect(); ownerReady = true;
    await runtime.connect(); runtimeReady = true;
    const [{ db }] = (await owner.query('SELECT current_database() AS db')).rows;
    const [{ db: runtimeDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(runtimeDb, db);
    assert.ok(isSafeRuntimeDbRole(role), 'application DB connection must never bypass RLS');
    const [security] = (await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid='public.memberships'::regclass
    `)).rows;
    assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true });
    const [policy] = (await owner.query(`
      SELECT qual, with_check FROM pg_policies
      WHERE schemaname='public' AND tablename='memberships'
    `)).rows;
    assert.match(policy.qual, /current_tenant_id/);
    assert.match(policy.with_check, /current_tenant_id/);
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function tenant(label) {
      const id = await create(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, 'RLS member ' + label, 'member-force-' + label + '-' + suffix]);
      tenants.push(id);
      return id;
    }
    const a = await tenant('a'), b = await tenant('b');
    async function user(label) {
      const email = 'member-force-' + suffix + '-' + label + '@example.test';
      const id = await create(
        'INSERT INTO users(email,full_name,password_hash) VALUES($1,$2,$3) RETURNING id',
        [email, 'Member RLS ' + label, await hashPassword(password)]);
      users.push(id);
      return { id, email };
    }
    const both = await user('both'), onlyB = await user('onlyb');
    await owner.query(
      "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES " +
      "($1,$3,'tenant_admin','active'),($2,$3,'scout','active'),($2,$4,'scout','active')",
      [a, b, both.id, onlyB.id]);

    const outside = await runtime.query('SELECT tenant_id,user_id FROM memberships');
    assert.equal(outside.rowCount, 0, 'no tenant context must reveal no membership');
    const outsideUpdate = await runtime.query(
      "UPDATE memberships SET status='blocked' WHERE user_id=$1 RETURNING id", [both.id]);
    assert.equal(outsideUpdate.rowCount, 0, 'no GUC write must change no rows');
    const outsideDelete = await runtime.query(
      'DELETE FROM memberships WHERE user_id=$1 RETURNING id', [both.id]);
    assert.equal(outsideDelete.rowCount, 0, 'no GUC delete must remove no rows');

    await runtime.query('BEGIN');
    try {
      await runtime.query("SELECT set_config('app.current_tenant',$1,true)", [a]);
      const aRows = (await runtime.query(
        'SELECT tenant_id,user_id FROM memberships ORDER BY user_id')).rows;
      assert.deepEqual(aRows, [{ tenant_id: a, user_id: both.id }]);
      const cross = await runtime.query(
        "UPDATE memberships SET status='blocked' WHERE tenant_id=$1 RETURNING id", [b]);
      assert.equal(cross.rowCount, 0, 'tenant A cannot change tenant B membership');
      await runtime.query("SELECT set_config('app.current_tenant',$1,true)", [b]);
      const bRows = (await runtime.query(
        'SELECT tenant_id,user_id FROM memberships ORDER BY user_id')).rows;
      assert.deepEqual(new Set(bRows.map(x => x.user_id)), new Set([both.id, onlyB.id]));
      assert.ok(bRows.every(x => x.tenant_id === b));
    } finally { await runtime.query('ROLLBACK'); }
    assert.equal((await runtime.query('SELECT id FROM memberships')).rowCount, 0,
      'transaction-local GUC must reset after rollback');

    const wrong = await fetch(url + '/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: both.email, password: 'incorrect password' })
    });
    assert.equal(wrong.status, 401);
    const choices = await login(both.email);
    assert.equal(choices.status, 200, JSON.stringify(choices.body));
    assert.equal(choices.body.requiresTenantSelection, true);
    assert.deepEqual(new Set(choices.body.memberships.map(x => x.tenantId)), new Set([a, b]));
    assert.equal(choices.body.memberships.length, 2);
    const selected = await login(both.email, { tenantId: b });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(selected.body.tenant.id, b);
    assert.equal(selected.body.membership.roleCode, 'scout');
    const denied = await login(both.email, { tenantId: a,
      tenantSlug: 'member-force-b-' + suffix });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.token, undefined);

    const different = await login(onlyB.email);
    assert.equal(different.status, 200);
    assert.equal(different.body.tenant.id, b);
    assert.equal(different.body.memberships, undefined);

    // Revoke B membership: discovery returns only A for this account.
    await owner.query(
      "UPDATE memberships SET status='blocked' WHERE tenant_id=$1 AND user_id=$2",
      [b, both.id]);
    const afterBlock = await login(both.email);
    assert.equal(afterBlock.status, 200);
    assert.equal(afterBlock.body.tenant.id, a);
    const cannotIssue = await login(both.email, { tenantId: b });
    assert.equal(cannotIssue.status, 403);
    // The true runtime limit is a catalog threshold, not the number of
    // memberships for one account. A pilot that reaches 251+ eligible
    // companies must guide users toward the indexed one-tenant selector.
    // Owner-only fixture seed; the HTTP handler still runs as nonowner with
    // FORCE RLS and never gets an unrestricted memberships privilege.
    const added = (await owner.query(`
      INSERT INTO tenants(plan_id,name,slug,status)
      SELECT $1::uuid, 'Capacity fixture ' || g,
             'member-cap-' || $2::text || '-' || g, 'active'
      FROM generate_series(1,251) AS g
      RETURNING id
    `, [plan.id, suffix])).rows;
    assert.equal(added.length, 251);
    tenants.push(...added.map(row => row.id));
    const overCapacity = await login(both.email);
    assert.equal(overCapacity.status, 503, JSON.stringify(overCapacity.body));
    assert.equal(overCapacity.body.error.code, 'LOGIN_DISCOVERY_CAPACITY_LIMIT');
    assert.equal(overCapacity.body.memberships, undefined,
      'capacity rejection must not expose any partial company list');
    assert.equal(overCapacity.body.token, undefined);

    const directA = await login(both.email, {
      tenantSlug: 'member-force-a-' + suffix
    });
    assert.equal(directA.status, 200, JSON.stringify(directA.body));
    assert.equal(directA.body.tenant.id, a);
    assert.equal(directA.body.tenant.slug, 'member-force-a-' + suffix);
    assert.equal(directA.body.membership.roleCode, 'tenant_admin');

    const directBlocked = await login(both.email, {
      tenantSlug: 'member-force-b-' + suffix
    });
    assert.equal(directBlocked.status, 403,
      'explicit slug must never resurrect a blocked membership');
    assert.equal(directBlocked.body.token, undefined);
    const foreignSelector = await login(onlyB.email, {
      tenantSlug: 'member-force-a-' + suffix
    });
    assert.equal(foreignSelector.status, 403,
      'a password-confirmed account cannot login to a company with no membership');
    assert.equal(foreignSelector.body.token, undefined);
    const exactB = await login(onlyB.email, {
      tenantSlug: 'member-force-b-' + suffix
    });
    assert.equal(exactB.status, 200);
    assert.equal(exactB.body.tenant.id, b);
    assert.equal(exactB.body.membership.roleCode, 'scout');

    const invalidPassword = await fetch(url + '/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: both.email, password: 'not-the-password' })
    });
    assert.equal(invalidPassword.status, 401,
      'global account/password checks must precede catalog capacity failure');

  } finally {
    if (ownerReady) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await owner.end(); }
    }
    if (runtimeReady) await runtime.end();
  }
});
