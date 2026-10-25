// Durable campaign creation acceptance against migrated disposable PostGIS.
// Uses non-owner runtime DB role and real HTTP under FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('campaignCreateIdempotency needs disposable *_test DB URLs');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'campaign-create-replay-ci-only';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('campaign keys provide exact actor-scoped atomic replay, conflict and tombstones', async t => {
  const admin = new pg.Client({ connectionString: adminUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/campaigns';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let adminReady = false, runtimeReady = false;
  const insert = async (query, args) => (await admin.query(query, args)).rows[0].id;
  async function send(identity, tid, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + identity.token, 'x-tenant-id': tid,
        'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: resp.status, body: await resp.json() };
  }
  try {
    await admin.connect(); adminReady = true;
    await runtime.connect(); runtimeReady = true;
    const [{ db }] = (await admin.query('SELECT current_database() AS db')).rows;
    const [{ app_db, ...role }] = (await runtime.query(`
      SELECT current_database() AS app_db,r.rolname,r.rolsuper,r.rolbypassrls,
        r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(app_db, db);
    assert.ok(isSafeRuntimeDbRole(role), 'do not use owner/superuser runtime');
    const policies = (await admin.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid=ANY(ARRAY[
        'public.campaign_create_requests'::regclass,
        'public.campaigns'::regclass])
    `)).rows;
    assert.equal(policies.length, 2);
    for (const row of policies) assert.ok(row.relrowsecurity && row.relforcerowsecurity, row.relname);

    const plan = (await admin.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function createTenant(tag) {
      const tid = await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, 'Campaign replay ' + tag, 'campaign-replay-' + tag + '-' + suffix]);
      tenants.push(tid);
      await admin.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES($1,'campaigns',true,'plan')",
        [tid]);
      return tid;
    }
    const a = await createTenant('a'), b = await createTenant('b');
    async function makeUser(tid, name, roleCode) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [name, 'campaign-replay-' + suffix + '-' + name.replaceAll(' ', '-') + '@example.test']);
      users.push(id);
      await admin.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid, id, roleCode]);
      return { id, token: signSession({ sub: id, role_code: roleCode, tenant_id: tid }) };
    }
    const ownerA = await makeUser(a, 'admin a', 'tenant_admin');
    const otherA = await makeUser(a, 'other a', 'tenant_admin');
    const scoutA = await makeUser(a, 'scout a', 'scout');
    const ownerB = await makeUser(b, 'admin b', 'tenant_admin');
    const key = randomUUID();
    const body = { client_request_id: key, name: 'Soy 2026 ' + suffix,
      season_year: 2026, starts_at: '2026-09-01', ends_at: '2027-04-30', status: 'planned' };

    const forbidden = await send(scoutA, a, body);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    const badDate = await send(ownerA, a, { ...body, ends_at: '2026-08-01' });
    assert.equal(badDate.status, 422, JSON.stringify(badDate.body));
    const missing = (await admin.query(
      'SELECT count(*)::int AS n FROM campaign_create_requests WHERE tenant_id=$1',
      [a])).rows[0].n;
    assert.equal(missing, 0, 'no key reserved for a rejected payload');

    const first = await send(ownerA, a, body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    const id = first.body.data.id;

    const replay = await send(ownerA, a, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.data.id, id);

    const changed = await send(ownerA, a, { ...body, status: 'active' });
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.error.code, 'CAMPAIGN_CREATE_REQUEST_CONFLICT');
    const dateChanged = await send(ownerA, a, { ...body, starts_at: '2026-09-02' });
    assert.equal(dateChanged.status, 409, JSON.stringify(dateChanged.body));

    const otherActor = await send(otherA, a, { ...body, name: 'Other actor ' + suffix });
    assert.equal(otherActor.status, 201, JSON.stringify(otherActor.body));
    assert.notEqual(otherActor.body.data.id, id);
    const tenantB = await send(ownerB, b, { ...body, name: 'Tenant B ' + suffix });
    assert.equal(tenantB.status, 201, JSON.stringify(tenantB.body));

    const both = { ...body, client_request_id: randomUUID(), name: 'Concurrent ' + suffix };
    const simultaneous = await Promise.all([
      send(ownerA, a, both), send(ownerA, a, both)
    ]);
    assert.deepEqual(simultaneous.map(x => x.status).sort(), [200, 201],
      JSON.stringify(simultaneous));
    assert.equal(simultaneous[0].body.data.id, simultaneous[1].body.data.id);

    const legacy = await send(ownerA, a, {
      name: 'Legacy ' + suffix, season_year: 2026, starts_at: '2026-09-01'
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    assert.equal(legacy.body.replayed, undefined, 'backward-compatible clients');

    const count = (await admin.query(
      'SELECT count(*)::int AS n FROM campaigns WHERE tenant_id=$1 AND name=$2',
      [a, body.name])).rows[0].n;
    assert.equal(count, 1, 'original campaign not duplicated');
    const row = (await admin.query(
      'SELECT requested_by, campaign_id FROM campaign_create_requests WHERE tenant_id=$1 AND client_request_id=$2',
      [a, key])).rows;
    assert.equal(row.length, 2, 'same UUID is independent across actors');
    assert.ok(row.some(x => x.requested_by === ownerA.id && x.campaign_id === id));

    await admin.query("UPDATE campaigns SET status='active' WHERE id=$1", [id]);
    const replayAfterUpdate = await send(ownerA, a, body);
    assert.equal(replayAfterUpdate.status, 200);
    assert.equal(replayAfterUpdate.body.data.id, id);
    assert.equal(replayAfterUpdate.body.data.status, 'active');

    await admin.query(
      "UPDATE memberships SET status='blocked' WHERE tenant_id=$1 AND user_id=$2",
      [a, ownerA.id]);
    const revoked = await send(ownerA, a, body);
    assert.equal(revoked.status, 401, JSON.stringify(revoked.body));
    await admin.query(
      "UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2",
      [a, ownerA.id]);

    await admin.query('DELETE FROM campaigns WHERE id=$1', [id]);
    const tombstone = (await admin.query(
      'SELECT campaign_id FROM campaign_create_requests WHERE tenant_id=$1 AND requested_by=$2 AND client_request_id=$3',
      [a, ownerA.id, key])).rows[0];
    assert.equal(tombstone.campaign_id, null);
    const gone = await send(ownerA, a, body);
    assert.equal(gone.status, 409, JSON.stringify(gone.body));
    assert.equal(gone.body.error.code, 'CAMPAIGN_CREATE_RESULT_GONE');
  } finally {
    if (adminReady) {
      try {
        if (tenants.length) await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await admin.end(); }
    }
    if (runtimeReady) await runtime.end();
  }
});
