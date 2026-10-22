// Regression: editing a campaign must not silently move already linked field history.
// Run with migrated, seeded, disposable PostgreSQL/PostGIS *_test URLs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) {
  throw new Error('campaignFieldIdentity requires disposable PostGIS *_test admin/app URLs.');
}
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'campaign-field-identity-test-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('campaign-field identity is stable while agronomic details remain editable', async t => {
  const owner = new pg.Client({ connectionString: adminUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [];
  const users = [];
  let ownerConnected = false;
  let runtimeConnected = false;
  const id = async (sql, params) => (await owner.query(sql, params)).rows[0].id;
  const count = async (sql, params) => (await owner.query(sql, params)).rows[0].total;
  async function request(path, token, tenantId, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, json: await response.json() };
  }

  try {
    await owner.connect();
    ownerConnected = true;
    await runtime.connect();
    runtimeConnected = true;
    const [{ name: dbName }] = (await owner.query('SELECT current_database() AS name')).rows;
    const [{ db: runtimeDb, ...runtimeRole }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(dbName, /(?:^|[_-])test(?:$|[_-])/i, 'never touch real business DB');
    assert.equal(runtimeDb, dbName);
    assert.ok(isSafeRuntimeDbRole(runtimeRole), 'runtime role must not bypass RLS');
    const [security] = (await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid='public.campaign_fields'::regclass
    `)).rows;
    assert.ok(security.relrowsecurity && security.relforcerowsecurity);
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const crop = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    assert.ok(plan && crop, 'global seeds are required');

    const tenantA = await id(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Campaign identity A',$1,'active',$2) RETURNING id",
      [`campaign-identity-a-${suffix}`, plan.id]);
    tenants.push(tenantA);
    const tenantB = await id(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Campaign identity B',$1,'active',$2) RETURNING id",
      [`campaign-identity-b-${suffix}`, plan.id]);
    tenants.push(tenantB);

    async function member(tenantId, label, role) {
      const userId = await id(
        'INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,\'fixture\') RETURNING id',
        [label, `cf-identity-${suffix}-${label.replaceAll(' ', '-')}@example.test`]);
      users.push(userId);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, userId, role]);
      return { userId, token: signSession({ sub: userId, role_code: role, tenant_id: tenantId }) };
    }
    const adminA = await member(tenantA, 'admin a', 'tenant_admin');
    const scoutA = await member(tenantA, 'scout a', 'scout');
    const adminB = await member(tenantB, 'admin b', 'tenant_admin');

    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES " +
      "($1,'campaigns',true,'plan'),($2,'campaigns',true,'plan')",
      [tenantA, tenantB]);
    async function makeField(tenantId, label) {
      const farmId = await id(
        'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tenantId, `Campaign identity farm ${label}`]);
      return id('INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tenantId, farmId, `Campaign identity field ${label}`]);
    }
    const fieldA = await makeField(tenantA, 'A');
    const anotherFieldA = await makeField(tenantA, 'A2');
    const fieldB = await makeField(tenantB, 'B');
    async function makeCampaign(tenantId, fieldId, label) {
      const campaignId = await id(
        "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-01-01') RETURNING id",
        [tenantId, `Identity campaign ${label}`]);
      const campaignFieldId = await id(
        'INSERT INTO campaign_fields(tenant_id,campaign_id,field_id,crop_type_id) VALUES($1,$2,$3,$4) RETURNING id',
        [tenantId, campaignId, fieldId, crop.id]);
      return { campaignId, campaignFieldId };
    }
    const a = await makeCampaign(tenantA, fieldA, 'A');
    const b = await makeCampaign(tenantB, fieldB, 'B');
    const endpoint = `/campaigns/${a.campaignId}/fields/${a.campaignFieldId}`;
    const untouchedEndpoint = `/campaigns/${b.campaignId}/fields/${b.campaignFieldId}`;

    // Seed already linked evidence/history, and verify that a PATCH cannot
    // reinterpret an observation's recorded lot or an existing order's lot.
    const runId = await id(
      "INSERT INTO scouting_runs(tenant_id,campaign_field_id,assigned_to,status) VALUES($1,$2,$3,'planned') RETURNING id",
      [tenantA, a.campaignFieldId, scoutA.userId]);
    const observationId = await id(
      "INSERT INTO scouting_observations(tenant_id,scouting_run_id,field_id,observed_by,observation_type,notes) VALUES($1,$2,$3,$4,'general','Original lot GPS notes') RETURNING id",
      [tenantA, runId, fieldA, scoutA.userId]);
    const orderId = await id(
      "INSERT INTO work_orders(tenant_id,field_id,campaign_field_id,title,type,status) VALUES($1,$2,$3,'Inspect existing lot','inspection','draft') RETURNING id",
      [tenantA, fieldA, a.campaignFieldId]);

    const move = await request(endpoint, adminA.token, tenantA, 'PATCH',
      { field_id: anotherFieldA });
    assert.equal(move.status, 409, JSON.stringify(move.json));
    assert.equal(move.json.error.code, 'CAMPAIGN_FIELD_IDENTITY_IMMUTABLE');

    // Immutability also applies to an unused campaign-field: prevents races
    // with concurrent scouting/order creation, instead of only checking children.
    const unlinked = await makeCampaign(tenantA, anotherFieldA, 'Unlinked');
    const moveUnused = await request(
      `/campaigns/${unlinked.campaignId}/fields/${unlinked.campaignFieldId}`,
      adminA.token, tenantA, 'PATCH', { field_id: fieldA });
    assert.equal(moveUnused.status, 409, JSON.stringify(moveUnused.json));

    const deniedOtherTenant = await request(untouchedEndpoint,
      adminA.token, tenantA, 'PATCH', { status: 'active' });
    assert.equal(deniedOtherTenant.status, 404, JSON.stringify(deniedOtherTenant.json));
    const deniedScout = await request(endpoint, scoutA.token, tenantA, 'PATCH',
      { status: 'active' });
    assert.equal(deniedScout.status, 403, JSON.stringify(deniedScout.json));

    // A redundant unchanged field_id and legitimate agronomic edits remain safe.
    const updated = await request(endpoint, adminA.token, tenantA, 'PATCH',
      { field_id: fieldA, status: 'active', expected_yield: 12 });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.data.field_id, fieldA);
    assert.equal(updated.json.data.status, 'active');
    assert.equal(Number(updated.json.data.expected_yield), 12);
    const changedWithoutIdentity = await request(endpoint, adminA.token, tenantA,
      'PATCH', { harvest_target_date: '2026-12-01' });
    assert.equal(changedWithoutIdentity.status, 200, JSON.stringify(changedWithoutIdentity.json));

    const facts = (await owner.query(`
      SELECT cf.field_id AS campaign_field_id, sr.campaign_field_id AS run_cf_id,
        so.field_id AS observation_field_id, wo.field_id AS order_field_id,
        wo.campaign_field_id AS order_cf_id
      FROM campaign_fields cf
      JOIN scouting_runs sr ON sr.campaign_field_id=cf.id
      JOIN scouting_observations so ON so.scouting_run_id=sr.id
      JOIN work_orders wo ON wo.campaign_field_id=cf.id
      WHERE cf.tenant_id=$1 AND cf.id=$2 AND so.id=$3 AND wo.id=$4
    `, [tenantA, a.campaignFieldId, observationId, orderId])).rows[0];
    assert.deepEqual([
      facts.campaign_field_id, facts.run_cf_id, facts.observation_field_id,
      facts.order_field_id, facts.order_cf_id
    ], [fieldA, a.campaignFieldId, fieldA, fieldA, a.campaignFieldId]);
    assert.equal(await count(
      'SELECT count(*)::int AS total FROM campaign_fields WHERE tenant_id=$1 AND field_id=$2 AND id=$3',
      [tenantA, anotherFieldA, a.campaignFieldId]), 0);
    const allowedOtherTenant = await request(untouchedEndpoint,
      adminB.token, tenantB, 'PATCH', { status: 'active' });
    assert.equal(allowedOtherTenant.status, 200, JSON.stringify(allowedOtherTenant.json));
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
