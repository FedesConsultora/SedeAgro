// 0U.6 — team roster lifecycle and idempotent retry against real Express/PostGIS.
// Requires existing migrated and seeded disposable PostgreSQL *_test URLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !runtimeUrl) {
  throw new Error('teamMemberLifecycle requires disposable PostGIS *_test owner/app URLs.');
}
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'team-membership-lifecycle-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('team roster accepts only active local members, hides revoked members, and deduplicates retry', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: runtimeUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerConnected = false, runtimeConnected = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;

  async function request(path, token, tenantId, method = 'GET', data) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        ...(data === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    return { status: response.status, json: await response.json() };
  }
  try {
    await owner.connect();
    ownerConnected = true;
    await runtime.connect();
    runtimeConnected = true;
    const [{ db }] = (await owner.query('SELECT current_database() AS db')).rows;
    const [{ database: runtimeDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS database, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
      WHERE r.rolname = current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i, 'refuse non-test database');
    assert.equal(runtimeDb, db);
    assert.ok(isSafeRuntimeDbRole(role), 'application role must not bypass RLS');
    const policies = (await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = ANY(ARRAY['public.teams'::regclass,'public.team_members'::regclass,
        'public.memberships'::regclass])
    `)).rows;
    assert.equal(policies.length, 3);
    for (const policy of policies) {
      assert.ok(policy.relrowsecurity && policy.relforcerowsecurity, policy.relname);
    }

    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const tenantA = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Team lifecycle A',$2,'active') RETURNING id",
      [plan.id, `team-lifecycle-a-${suffix}`]);
    tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Team lifecycle B',$2,'active') RETURNING id",
      [plan.id, `team-lifecycle-b-${suffix}`]);
    tenants.push(tenantB);

    async function member(tenantId, label, roleCode, membershipStatus = 'active', userStatus = 'active') {
      const userId = await insert(
        'INSERT INTO users(full_name,email,password_hash,status) VALUES($1,$2,\'fixture\',$3) RETURNING id',
        [label, `team-lifecycle-${suffix}-${label.replaceAll(' ', '-')}@example.test`, userStatus]);
      users.push(userId);
      await owner.query(
        'INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,$4)',
        [tenantId, userId, roleCode, membershipStatus]);
      return {
        id: userId,
        token: signSession({ sub: userId, role_code: roleCode, tenant_id: tenantId })
      };
    }
    const adminA = await member(tenantA, 'admin a', 'tenant_admin');
    const activeScout = await member(tenantA, 'scout a', 'scout');
    const pendingScout = await member(tenantA, 'pending scout', 'scout', 'pending');
    const blockedScout = await member(tenantA, 'blocked scout', 'scout', 'blocked');
    const disabledScout = await member(tenantA, 'disabled scout', 'scout', 'active', 'blocked');
    const adminB = await member(tenantB, 'admin b', 'tenant_admin');
    const foreignScout = await member(tenantB, 'foreign scout', 'scout');
    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES " +
      "($1,'org',true,'plan'),($2,'org',true,'plan')", [tenantA, tenantB]);

    const teamA = await request('/teams', adminA.token, tenantA, 'POST',
      { name: `Pilot field operators ${suffix}`, scope: 'field_ops' });
    assert.equal(teamA.status, 201, JSON.stringify(teamA.json));
    const teamId = teamA.json.data.id;
    const teamB = await request('/teams', adminB.token, tenantB, 'POST',
      { name: `Other organization team ${suffix}`, scope: 'field_ops' });
    assert.equal(teamB.status, 201, JSON.stringify(teamB.json));
    const addPath = `/teams/${teamId}/members`;

    const added = await request(addPath, adminA.token, tenantA, 'POST',
      { user_id: activeScout.id, role_label: 'Monitoreo' });
    assert.equal(added.status, 201, JSON.stringify(added.json));
    const memberId = added.json.data.id;
    const repeat = await request(addPath, adminA.token, tenantA, 'POST',
      { user_id: activeScout.id, role_label: 'Monitoreo' });
    assert.equal(repeat.status, 200, JSON.stringify(repeat.json));
    assert.equal(repeat.json.data.id, memberId, 'exact replay reuses persisted team member');
    const conflictingReplay = await request(addPath, adminA.token, tenantA, 'POST',
      { user_id: activeScout.id, role_label: 'Administración' });
    assert.equal(conflictingReplay.status, 409, JSON.stringify(conflictingReplay.json));
    assert.equal(conflictingReplay.json.error.code, 'TEAM_MEMBER_ROLE_CONFLICT');

    for (const user of [pendingScout, blockedScout, disabledScout, foreignScout]) {
      const denied = await request(addPath, adminA.token, tenantA, 'POST',
        { user_id: user.id, role_label: 'Monitoreo' });
      assert.equal(denied.status, 422, JSON.stringify(denied.json));
      assert.equal(denied.json.error.code, 'TEAM_MEMBER_NOT_ACTIVE');
    }
    const absent = await request(`/teams/${randomUUID()}/members`, adminA.token, tenantA,
      'POST', { user_id: activeScout.id });
    assert.equal(absent.status, 404, JSON.stringify(absent.json));
    const tenantForeignTeam = await request(`/teams/${teamB.json.data.id}/members`,
      adminA.token, tenantA, 'POST', { user_id: activeScout.id });
    assert.equal(tenantForeignTeam.status, 404);
    const deniedRole = await request(addPath, activeScout.token, tenantA,
      'POST', { user_id: activeScout.id });
    assert.equal(deniedRole.status, 403);

    async function visibleTeamMembers() {
      const response = await request('/teams', adminA.token, tenantA);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.deepEqual(response.json.data.map(x => x.id), [teamId],
        'team listing must be tenant scoped');
      return response.json.data[0].TeamMembers;
    }
    assert.deepEqual((await visibleTeamMembers()).map(x => x.user_id), [activeScout.id]);

    // Retaining the historical FK row must never keep a revoked user's
    // contact details visible in an operational roster.
    await owner.query(
      "UPDATE memberships SET status='blocked' WHERE tenant_id=$1 AND user_id=$2",
      [tenantA, activeScout.id]);
    assert.deepEqual(await visibleTeamMembers(), [],
      'revoking tenant membership must hide name/email on next read');
    await owner.query(
      "UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2",
      [tenantA, activeScout.id]);
    await owner.query("UPDATE users SET status='blocked' WHERE id=$1", [activeScout.id]);
    assert.deepEqual(await visibleTeamMembers(), [],
      'disabled global user must also be hidden');
    await owner.query("UPDATE users SET status='active' WHERE id=$1", [activeScout.id]);
    assert.deepEqual((await visibleTeamMembers()).map(x => x.user_id), [activeScout.id]);

    const persisted = (await owner.query(
      'SELECT id,role_label FROM team_members WHERE tenant_id=$1 AND team_id=$2 AND user_id=$3',
      [tenantA, teamId, activeScout.id])).rows;
    assert.equal(persisted.length, 1, 'no retry duplicate or hidden implicit deletion');
    assert.deepEqual([persisted[0].id, persisted[0].role_label], [memberId, 'Monitoreo']);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM team_members WHERE tenant_id=$1',
      [tenantB])).rows[0].n, 0);
  } finally {
    if (ownerConnected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      } finally {
        await owner.end();
      }
    }
    if (runtimeConnected) await runtime.end();
  }
});
