// 0U.20 — persistent multi-worker scouting creation receipt acceptance.
// Real HTTP with a disposable seeded/migrated *_test PostGIS and non-owner FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !runtimeUrl) throw new Error('scoutingRunCreateIdempotency needs disposable *_test DB URLs');
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'scouting-run-create-replay-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('durable run key serializes requests, prevents changed replay and audit/notice duplication', async t => {
  const owner = new pg.Client({ connectionString: adminUrl });
  const runtime = new pg.Client({ connectionString: runtimeUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/scouting/runs`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let hasOwner = false, hasRuntime = false;
  const insert = async (sql, args) => (await owner.query(sql, args)).rows[0].id;
  const send = async (token, tid, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tid,
        'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await owner.connect(); hasOwner = true;
    await runtime.connect(); hasRuntime = true;
    const [{ name: db }] = (await owner.query('SELECT current_database() AS name')).rows;
    const [{ app_db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS app_db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i, 'never mutate a production database');
    assert.equal(appDb, db);
    assert.ok(isSafeRuntimeDbRole(role), 'FORCE RLS requires non-owner runtime role');
    const guard = (await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid=ANY(ARRAY[
        'public.scouting_run_create_requests'::regclass,
        'public.scouting_runs'::regclass,
        'public.audit_events'::regclass,
        'public.notifications'::regclass])
    `)).rows;
    assert.equal(guard.length, 4);
    for (const row of guard) assert.ok(row.relrowsecurity && row.relforcerowsecurity, row.relname);
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const crop = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    assert.ok(plan && crop);

    async function makeTenant(label) {
      const id = await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, `Scouting replay ${label}`, `scout-replay-${label}-${suffix}`]);
      tenants.push(id);
      await owner.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES($1,'scouting',true,'plan')",
        [id]);
      return id;
    }
    const a = await makeTenant('a');
    const b = await makeTenant('b');
    async function member(tid, name, roleCode) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [name, `scout-replay-${suffix}-${name.replaceAll(' ', '-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid, id, roleCode]);
      return { id, token: signSession({ sub: id, role_code: roleCode, tenant_id: tid }) };
    }
    const adminA = await member(a, 'admin a', 'tenant_admin');
    const otherAdminA = await member(a, 'other admin a', 'tenant_admin');
    const scoutA = await member(a, 'scout a', 'scout');
    const adminB = await member(b, 'admin b', 'tenant_admin');

    async function campaignField(tid, name) {
      const farm = await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tid, `Farm ${name}`]);
      const field = await insert(
        'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tid, farm, `Field ${name}`]);
      const campaign = await insert(
        "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-01-01') RETURNING id",
        [tid, `Campaign ${name}`]);
      return insert(
        'INSERT INTO campaign_fields(tenant_id,campaign_id,field_id,crop_type_id) VALUES($1,$2,$3,$4) RETURNING id',
        [tid, campaign, field, crop.id]);
    }
    const cfA = await campaignField(a, `a-${suffix}`);
    const cfB = await campaignField(b, `b-${suffix}`);
    const key = randomUUID();
    const body = {
      client_request_id: key, campaign_field_id: cfA, assigned_to: scoutA.id,
      status: 'planned', summary: 'Revisar lote norte',
      scheduled_at: '2026-10-24T10:00:00-03:00'
    };
    const a1 = await send(adminA.token, a, body);
    assert.equal(a1.status, 201, JSON.stringify(a1.body));
    assert.equal(a1.body.replayed, false);
    const id = a1.body.data.id;
    const a2 = await send(adminA.token, a,
      { ...body, scheduled_at: '2026-10-24T13:00:00Z' });
    assert.equal(a2.status, 200, JSON.stringify(a2.body));
    assert.equal(a2.body.replayed, true);
    assert.equal(a2.body.data.id, id);

    for (const changed of [
      { summary: 'Otra descripción' },
      { campaign_field_id: cfB },
      { assigned_to: null },
      { status: 'in_progress' },
      { scheduled_at: '2026-10-24T14:00:00Z' }
    ]) {
      const rejected = await send(adminA.token, a, { ...body, ...changed });
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.code, 'SCOUTING_CREATE_REQUEST_CONFLICT');
    }
    const denied = await send(scoutA.token, a, body);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const deniedTenant = await send(adminA.token, b, body);
    assert.equal(deniedTenant.status, 403, JSON.stringify(deniedTenant.body));

    // The same UUID isn't a global secret: another authorized actor has its
    // own namespace, and another tenant cannot see the original receipt.
    const secondActor = await send(otherAdminA.token, a, body);
    assert.equal(secondActor.status, 201, JSON.stringify(secondActor.body));
    assert.notEqual(secondActor.body.data.id, id);
    const tenantBRun = await send(adminB.token, b, {
      ...body, campaign_field_id: cfB, assigned_to: null
    });
    assert.equal(tenantBRun.status, 201, JSON.stringify(tenantBRun.body));
    assert.notEqual(tenantBRun.body.data.id, id);

    // Simulate two workers accepting the same key concurrently.
    const concurrentBody = { ...body, client_request_id: randomUUID() };
    const concurrent = await Promise.all([
      send(adminA.token, a, concurrentBody),
      send(adminA.token, a, concurrentBody)
    ]);
    assert.deepEqual(concurrent.map(x => x.status).sort(), [200, 201],
      JSON.stringify(concurrent));
    assert.equal(concurrent[0].body.data.id, concurrent[1].body.data.id);

    // Distinct keys may legitimately plan identical runs.
    const independent = await send(adminA.token, a,
      { ...body, client_request_id: randomUUID() });
    assert.equal(independent.status, 201, JSON.stringify(independent.body));
    assert.notEqual(independent.body.data.id, id);
    const legacy = await send(adminA.token, a, {
      campaign_field_id: cfA, status: 'planned', assigned_to: null
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    assert.equal(legacy.body.replayed, undefined, 'old clients retain legacy response');

    const artifacts = (await owner.query(`
      SELECT
        (SELECT count(*)::int FROM scouting_run_create_requests
          WHERE tenant_id=$1 AND requested_by=$2 AND client_request_id=$3) AS receipts,
        (SELECT count(*)::int FROM audit_events
          WHERE tenant_id=$1 AND entity_id=$4 AND action='scouting.run.created') AS audits,
        (SELECT count(*)::int FROM notifications
          WHERE tenant_id=$1 AND entity_id=$4 AND entity_type='scouting_run') AS notices
    `, [a, adminA.id, key, id])).rows[0];
    assert.deepEqual(artifacts, { receipts: 1, audits: 1, notices: 1 },
      'only one audit and assignment notification per creation receipt');

    // Existing run status may change; compare the immutable original payload,
    // not the run's mutable current status/summary.
    await owner.query("UPDATE scouting_runs SET summary='Updated later' WHERE id=$1", [id]);
    const changedRun = await send(adminA.token, a, body);
    assert.equal(changedRun.status, 200, JSON.stringify(changedRun.body));
    assert.equal(changedRun.body.data.id, id);
    assert.equal(changedRun.body.data.summary, 'Updated later');

    // Real membership revocation is checked before any receipt lookup.
    await owner.query(
      "UPDATE memberships SET status='blocked' WHERE tenant_id=$1 AND user_id=$2",
      [a, adminA.id]);
    const revoked = await send(adminA.token, a, body);
    assert.equal(revoked.status, 403, JSON.stringify(revoked.body));
    await owner.query(
      "UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2",
      [a, adminA.id]);

    // Delete the referenced run: FK SET NULL preserves durable tombstone.
    await owner.query('DELETE FROM scouting_runs WHERE id=$1', [id]);
    const [tombstone] = (await owner.query(
      'SELECT run_id FROM scouting_run_create_requests WHERE tenant_id=$1 AND requested_by=$2 AND client_request_id=$3',
      [a, adminA.id, key])).rows;
    assert.equal(tombstone.run_id, null);
    const gone = await send(adminA.token, a, body);
    assert.equal(gone.status, 409, JSON.stringify(gone.body));
    assert.equal(gone.body.error.code, 'SCOUTING_CREATE_RESULT_GONE');
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM scouting_runs WHERE id=$1', [id])).rows[0].n, 0);
  } finally {
    if (hasOwner) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await owner.end(); }
    }
    if (hasRuntime) await runtime.end();
  }
});
