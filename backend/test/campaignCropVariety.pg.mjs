// 0U.4: field crop/variety coherence with the real tenant HTTP API and PostGIS.
// Run only in a migrated, seeded, disposable *_test database (owner + non-owner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !runtimeUrl) {
  throw new Error('campaignCropVariety requires disposable PostgreSQL *_test URLs.');
}
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'campaign-variety-coherence-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('campaign fields never persist crop varieties from another crop, including partial PATCH', async t => {
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
  const tenants = [];
  const users = [];
  const varieties = [];
  let ownerConnected = false;
  let runtimeConnected = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;
  async function request(path, token, tenantId, method, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, json: await res.json() };
  }

  try {
    await owner.connect();
    ownerConnected = true;
    await runtime.connect();
    runtimeConnected = true;
    const [{ name: ownerDb }] = (await owner.query('SELECT current_database() AS name')).rows;
    const [{ db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(ownerDb, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(appDb, ownerDb);
    assert.ok(isSafeRuntimeDbRole(role), 'runtime DB user must not bypass RLS');
    const [security] = (await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid='public.campaign_fields'::regclass
    `)).rows;
    assert.ok(security.relrowsecurity && security.relforcerowsecurity);

    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const soy = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    const corn = (await owner.query("SELECT id FROM crop_types WHERE code='corn'")).rows[0];
    assert.ok(plan && soy && corn, 'seeded distinct crop types required');

    // Catalog entries are global; use unique fixture names and remove them last.
    const soyVariety = await insert(
      'INSERT INTO crop_varieties(crop_type_id,name) VALUES($1,$2) RETURNING id',
      [soy.id, `CI Soy variety ${suffix}`]);
    varieties.push(soyVariety);
    const cornVariety = await insert(
      'INSERT INTO crop_varieties(crop_type_id,name) VALUES($1,$2) RETURNING id',
      [corn.id, `CI Corn variety ${suffix}`]);
    varieties.push(cornVariety);

    const tenantA = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Crop variety A',$1,'active',$2) RETURNING id",
      [`crop-variety-a-${suffix}`, plan.id]);
    tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Crop variety B',$1,'active',$2) RETURNING id",
      [`crop-variety-b-${suffix}`, plan.id]);
    tenants.push(tenantB);

    async function member(tenantId, label, roleCode) {
      const userId = await insert(
        'INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,\'fixture\') RETURNING id',
        [label, `crop-variety-${suffix}-${label.replaceAll(' ', '-')}@example.test`]);
      users.push(userId);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, userId, roleCode]);
      return signSession({ sub: userId, role_code: roleCode, tenant_id: tenantId });
    }
    const adminA = await member(tenantA, 'admin a', 'tenant_admin');
    const adminB = await member(tenantB, 'admin b', 'tenant_admin');
    const scoutA = await member(tenantA, 'scout a', 'scout');

    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES " +
      "($1,'campaigns',true,'plan'),($2,'campaigns',true,'plan')",
      [tenantA, tenantB]);
    async function place(tenantId, tag) {
      const farm = await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tenantId, `Farm ${tag}`]);
      const field = await insert(
        'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tenantId, farm, `Field ${tag}`]);
      const campaign = await insert(
        "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-10-01') RETURNING id",
        [tenantId, `Campaign ${tag}`]);
      return { campaign, field };
    }
    const a = await place(tenantA, 'A');
    const b = await place(tenantB, 'B');
    const pathA = `/campaigns/${a.campaign}/fields`;
    const pathB = `/campaigns/${b.campaign}/fields`;

    const valid = await request(pathA, adminA, tenantA, 'POST',
      { field_id: a.field, crop_type_id: soy.id, crop_variety_id: soyVariety });
    assert.equal(valid.status, 201, JSON.stringify(valid.json));
    const cfId = valid.json.data.id;
    const updatePath = `${pathA}/${cfId}`;

    const otherField = await insert(
      'INSERT INTO fields(tenant_id,farm_id,name) ' +
      'SELECT tenant_id,farm_id,$2 FROM fields WHERE id=$1 RETURNING id',
      [a.field, `Second lot ${suffix}`]);
    const badCreate = await request(pathA, adminA, tenantA, 'POST',
      { field_id: otherField, crop_type_id: soy.id, crop_variety_id: cornVariety });
    assert.equal(badCreate.status, 422, JSON.stringify(badCreate.json));
    assert.equal(badCreate.json.error.code, 'CAMPAIGN_CROP_VARIETY_MISMATCH');
    const unknown = await request(pathA, adminA, tenantA, 'POST',
      { field_id: otherField, crop_type_id: soy.id, crop_variety_id: randomUUID() });
    assert.equal(unknown.status, 422);
    const unknownType = await request(pathA, adminA, tenantA, 'POST',
      { field_id: otherField, crop_type_id: randomUUID(), crop_variety_id: soyVariety });
    assert.equal(unknownType.status, 422);

    // A PATCH that changes only crop_type_id must compare the retained variety.
    const badTypeChange = await request(updatePath, adminA, tenantA, 'PATCH',
      { crop_type_id: corn.id });
    assert.equal(badTypeChange.status, 422, JSON.stringify(badTypeChange.json));
    assert.equal(badTypeChange.json.error.code, 'CAMPAIGN_CROP_VARIETY_MISMATCH');
    const badVarietyChange = await request(updatePath, adminA, tenantA, 'PATCH',
      { crop_variety_id: cornVariety });
    assert.equal(badVarietyChange.status, 422, JSON.stringify(badVarietyChange.json));
    assert.equal(badVarietyChange.json.error.code, 'CAMPAIGN_CROP_VARIETY_MISMATCH');

    const unchanged = (await owner.query(
      'SELECT crop_type_id,crop_variety_id,field_id FROM campaign_fields WHERE id=$1',
      [cfId])).rows[0];
    assert.deepEqual([unchanged.crop_type_id, unchanged.crop_variety_id, unchanged.field_id],
      [soy.id, soyVariety, a.field]);

    const cleared = await request(updatePath, adminA, tenantA, 'PATCH',
      { crop_variety_id: null, crop_type_id: corn.id });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.data.crop_variety_id, null);
    const compatible = await request(updatePath, adminA, tenantA, 'PATCH',
      { crop_variety_id: cornVariety });
    assert.equal(compatible.status, 200, JSON.stringify(compatible.json));
    const detailOnly = await request(updatePath, adminA, tenantA, 'PATCH',
      { expected_yield: 4 });
    assert.equal(detailOnly.status, 200, JSON.stringify(detailOnly.json));
    const noVariety = await request(pathA, adminA, tenantA, 'POST',
      { field_id: otherField, crop_type_id: soy.id });
    assert.equal(noVariety.status, 201, JSON.stringify(noVariety.json));

    const unauthorized = await request(updatePath, scoutA, tenantA, 'PATCH',
      { crop_variety_id: soyVariety });
    assert.equal(unauthorized.status, 403);
    const crossTenant = await request(updatePath, adminB, tenantB, 'PATCH',
      { crop_variety_id: soyVariety });
    assert.equal(crossTenant.status, 404);
    const foreignCampaign = await request(pathB, adminA, tenantA, 'POST',
      { field_id: a.field, crop_type_id: soy.id, crop_variety_id: soyVariety });
    assert.equal(foreignCampaign.status, 404, JSON.stringify(foreignCampaign.json));

    const stored = (await owner.query(
      'SELECT crop_type_id,crop_variety_id,field_id,expected_yield FROM campaign_fields WHERE id=$1',
      [cfId])).rows[0];
    assert.deepEqual([stored.crop_type_id, stored.crop_variety_id, stored.field_id],
      [corn.id, cornVariety, a.field]);
    assert.equal(Number(stored.expected_yield), 4);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS total FROM campaign_fields WHERE tenant_id=$1',
      [tenantA])).rows[0].total, 2, 'invalid creates must never persist');
    assert.equal((await owner.query(
      'SELECT count(*)::int AS total FROM campaign_fields WHERE tenant_id=$1',
      [tenantB])).rows[0].total, 0);
  } finally {
    if (ownerConnected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
        if (varieties.length) await owner.query(
          'DELETE FROM crop_varieties WHERE id = ANY($1::uuid[])', [varieties]);
      } finally {
        await owner.end();
      }
    }
    if (runtimeConnected) await runtime.end();
  }
});
