// 0U.2: real HTTP + PostgreSQL regression for campaign/field consistency.
// Runs ONLY with the existing migrated, seeded, disposable *_test PostGIS setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !appUrl) {
  throw new Error('workOrderCampaignField requires disposable PostgreSQL *_test owner/app URLs.');
}
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'work-order-campaign-field-gate-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('work orders cannot combine different fields or tenants with a campaign-field reference', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/work-orders`;
  const tenants = [];
  const users = [];
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let ownerConnected = false;
  let runtimeConnected = false;

  async function insert(query, params) {
    return (await owner.query(query, params)).rows[0].id;
  }
  async function request(token, tenantId, body) {
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() };
  }
  const order = (fieldId, campaignFieldId, title) => ({
    field_id: fieldId,
    ...(campaignFieldId === undefined ? {} : { campaign_field_id: campaignFieldId }),
    title,
    type: 'inspection'
  });

  try {
    await owner.connect();
    ownerConnected = true;
    await runtime.connect();
    runtimeConnected = true;
    const [{ name: ownerDb }] = (await owner.query('SELECT current_database() AS name')).rows;
    const [{ db: runtimeDb, ...runtimeRole }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(ownerDb, /(?:^|[_-])test(?:$|[_-])/i, 'never mutate production');
    assert.equal(runtimeDb, ownerDb);
    assert.ok(isSafeRuntimeDbRole(runtimeRole), 'API role must not bypass RLS');
    const security = (await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid='public.work_orders'::regclass
    `)).rows[0];
    assert.ok(security.relrowsecurity && security.relforcerowsecurity);
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const crop = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    assert.ok(plan && crop, 'CI global seed required');

    const a = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Integrity A',$1,'active',$2) RETURNING id",
      [`integrity-a-${suffix}`, plan.id]);
    tenants.push(a);
    const b = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Integrity B',$1,'active',$2) RETURNING id",
      [`integrity-b-${suffix}`, plan.id]);
    tenants.push(b);

    async function member(tenantId, name, role) {
      const id = await insert(
        'INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,\'fixture\') RETURNING id',
        [name, `integrity-${suffix}-${name.replaceAll(' ', '-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, id, role]);
      return signSession({ sub: id, role_code: role, tenant_id: tenantId });
    }
    const adminA = await member(a, 'admin a', 'tenant_admin');
    const scoutA = await member(a, 'scout a', 'scout');
    const adminB = await member(b, 'admin b', 'tenant_admin');

    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
      "($1,'work_orders',true,'plan'),($2,'work_orders',true,'plan')", [a, b]);

    async function makeField(tenantId, label) {
      const farmId = await insert(
        'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tenantId, `Farm ${label}`]);
      return insert('INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tenantId, farmId, `Field ${label}`]);
    }
    const fieldA1 = await makeField(a, 'A1');
    const fieldA2 = await makeField(a, 'A2');
    const fieldB = await makeField(b, 'B');
    async function makeCampaignField(tenantId, fieldId, label) {
      const campaignId = await insert(
        "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-01-01') RETURNING id",
        [tenantId, label]);
      return insert(
        'INSERT INTO campaign_fields(tenant_id,campaign_id,field_id,crop_type_id) VALUES($1,$2,$3,$4) RETURNING id',
        [tenantId, campaignId, fieldId, crop.id]);
    }
    const cfA1 = await makeCampaignField(a, fieldA1, 'A1');
    const cfA2 = await makeCampaignField(a, fieldA2, 'A2');
    const cfB = await makeCampaignField(b, fieldB, 'B');

    const valid = await request(adminA, a, order(fieldA1, cfA1, 'Order with matching crop'));
    assert.equal(valid.status, 201, JSON.stringify(valid.json));
    const saved = (await owner.query(
      'SELECT tenant_id,field_id,campaign_field_id FROM work_orders WHERE id=$1',
      [valid.json.data.id])).rows[0];
    assert.deepEqual([saved.tenant_id, saved.field_id, saved.campaign_field_id],
      [a, fieldA1, cfA1], 'order must persist actual matched parent IDs');

    const withoutCampaign = await request(adminA, a,
      order(fieldA1, undefined, 'Inspection without selected campaign'));
    assert.equal(withoutCampaign.status, 201, JSON.stringify(withoutCampaign.json));
    assert.equal(withoutCampaign.json.data.campaign_field_id, null);

    const before = (await owner.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [a])).rows[0].n;
    assert.equal(before, 2);
    const mismatch = await request(adminA, a,
      order(fieldA1, cfA2, 'Must reject other field in same company'));
    assert.equal(mismatch.status, 422, JSON.stringify(mismatch.json));
    assert.equal(mismatch.json.error.code, 'WORK_ORDER_CAMPAIGN_FIELD_MISMATCH');
    const crossCampaign = await request(adminA, a,
      order(fieldA1, cfB, 'Must hide other company campaign'));
    assert.equal(crossCampaign.status, 404, JSON.stringify(crossCampaign.json));
    const crossField = await request(adminA, a,
      order(fieldB, cfA1, 'Must hide other company field'));
    assert.equal(crossField.status, 404, JSON.stringify(crossField.json));
    const missingCampaign = await request(adminA, a,
      order(fieldA1, randomUUID(), 'Unknown campaign-field'));
    assert.equal(missingCampaign.status, 404, JSON.stringify(missingCampaign.json));
    const noCapability = await request(scoutA, a,
      order(fieldA1, cfA1, 'Scout must not create work orders'));
    assert.equal(noCapability.status, 403);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [a])).rows[0].n,
    before, 'no invalid or denied orders may persist');

    const validB = await request(adminB, b,
      order(fieldB, cfB, 'Isolated company B valid order'));
    assert.equal(validB.status, 201, JSON.stringify(validB.json));
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [b])).rows[0].n,
    1);
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
