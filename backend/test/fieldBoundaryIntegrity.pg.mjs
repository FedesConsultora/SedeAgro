// 0U.16 — real HTTP/PostGIS boundary integrity under non-owner FORCE RLS.
// Disposable migrated/seeded *_test database only; no mocks or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !runtimeUrl) {
  throw new Error('fieldBoundaryIntegrity requires disposable *_test owner/app URLs');
}
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'field-boundary-integrity-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('lot GeoJSON is bounded, topologically valid and tenant-isolated on POST/PATCH', async t => {
  const owner = new pg.Client({ connectionString: adminUrl });
  const runtime = new pg.Client({ connectionString: runtimeUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [];
  const users = [];
  let ownerConnected = false;
  let runtimeConnected = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;

  async function send(path, token, tenantId, method, body) {
    const response = await fetch(url + path, {
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
    const [{ db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(dbName, /(?:^|[_-])test(?:$|[_-])/i, 'never use a business database');
    assert.equal(appDb, dbName);
    assert.ok(isSafeRuntimeDbRole(role), 'non-owner runtime must not bypass RLS');
    const rls = (await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.fields'::regclass,'public.farms'::regclass])
    `)).rows;
    assert.equal(rls.length, 2);
    for (const table of rls) assert.ok(table.relrowsecurity && table.relforcerowsecurity, table.relname);

    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan, 'seeded starter plan is required');
    async function createTenant(label) {
      const id = await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, `GIS boundary ${label}`, `gis-boundary-${label}-${suffix}`]);
      tenants.push(id);
      await owner.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES($1,'gis',true,'plan')",
        [id]);
      return id;
    }
    const tenantA = await createTenant('a');
    const tenantB = await createTenant('b');

    async function member(tenantId, label, roleCode) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label, `gis-boundary-${suffix}-${label.replaceAll(' ', '-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, id, roleCode]);
      return signSession({ sub: id, role_code: roleCode, tenant_id: tenantId });
    }
    const adminA = await member(tenantA, 'admin a', 'tenant_admin');
    const contractorA = await member(tenantA, 'contractor a', 'contractor');
    const adminB = await member(tenantB, 'admin b', 'tenant_admin');

    const farmA = await insert(
      'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantA, `Farm A ${suffix}`]);
    const farmB = await insert(
      'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantB, `Farm B ${suffix}`]);

    const polygon = coordinates => ({ type: 'Polygon', coordinates });
    const square = polygon([[[-58.5,-34.9],[-58.4,-34.9],[-58.4,-34.8],[-58.5,-34.8],[-58.5,-34.9]]]);
    const bowTie = polygon([[[-58.5,-34.9],[-58.4,-34.8],[-58.5,-34.8],[-58.4,-34.9],[-58.5,-34.9]]]);
    const unclosed = polygon([[[-58.5,-34.9],[-58.4,-34.9],[-58.4,-34.8],[-58.5,-34.8]]]);
    const collinear = polygon([[[-58.5,-34.9],[-58.4,-34.9],[-58.3,-34.9],[-58.5,-34.9]]]);
    const outOfRange = polygon([[[181,-34.9],[182,-34.9],[182,-34.8],[181,-34.9]]]);

    const other = await send('/fields', adminB, tenantB, 'POST',
      { name: `Other ${suffix}`, farm_id: farmB, boundary: square });
    assert.equal(other.status, 201, JSON.stringify(other.json));

    const unauthorized = await send('/fields', contractorA, tenantA, 'POST',
      { name: 'Contractor field', farm_id: farmA, boundary: square });
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.json));
    const crossTenant = await send('/fields', adminA, tenantA, 'POST',
      { name: 'Foreign field', farm_id: farmB, boundary: square });
    assert.equal(crossTenant.status, 404, JSON.stringify(crossTenant.json));

    const invalidCases = [
      ['wrong-type', { type: 'Point', coordinates: [-58.5, -34.9] }],
      ['unclosed', unclosed],
      ['collinear', collinear],
      ['out-of-range', outOfRange],
      ['self-intersection', bowTie],
      ['wrong-srid', { ...square, srid: 3857 }],
      ['malformed', 'not GeoJSON'],
      ['empty-rings', polygon([])]
    ];
    for (const [label, invalid] of invalidCases) {
      const result = await send('/fields', adminA, tenantA, 'POST',
        { name: `Invalid ${label}`, farm_id: farmA, boundary: invalid });
      assert.equal(result.status, 422, `${label}: ${JSON.stringify(result.json)}`);
      assert.equal(result.json.error.code, 'VALIDATION_ERROR',
        `${label}: validation must not leak SQL errors`);
    }

    const created = await send('/fields', adminA, tenantA, 'POST',
      { name: `Valid ${suffix}`, farm_id: farmA, boundary: square, area_hectares: 10.25 });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const fieldId = created.json.data.id;
    const stored = (await owner.query(`
      SELECT ST_IsValid(boundary) AS valid, ST_SRID(boundary) AS srid,
        ST_AsGeoJSON(boundary) AS geojson FROM fields WHERE id=$1 AND tenant_id=$2
    `, [fieldId, tenantA])).rows[0];
    assert.equal(stored.valid, true);
    assert.equal(stored.srid, 4326);
    assert.deepEqual(JSON.parse(stored.geojson).coordinates, square.coordinates);

    const invalidPatch = await send(`/fields/${fieldId}`, adminA, tenantA, 'PATCH',
      { boundary: bowTie });
    assert.equal(invalidPatch.status, 422, JSON.stringify(invalidPatch.json));
    const afterInvalid = (await owner.query(
      'SELECT ST_AsGeoJSON(boundary) AS geojson FROM fields WHERE id=$1',
      [fieldId])).rows[0];
    assert.deepEqual(JSON.parse(afterInvalid.geojson).coordinates, square.coordinates,
      'failed PATCH must retain the old valid polygon');

    const foreignPatch = await send(`/fields/${other.json.data.id}`, adminA, tenantA,
      'PATCH', { boundary: square });
    assert.equal(foreignPatch.status, 404, JSON.stringify(foreignPatch.json));

    const cleared = await send(`/fields/${fieldId}`, adminA, tenantA, 'PATCH',
      { boundary: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    const afterClear = (await owner.query('SELECT boundary IS NULL AS cleared FROM fields WHERE id=$1',
      [fieldId])).rows[0];
    assert.equal(afterClear.cleared, true, 'explicit null must permit clearing erroneous geometry');
    assert.equal((await owner.query(
      'SELECT count(*)::int AS count FROM fields WHERE tenant_id=$1', [tenantA])).rows[0].count, 1,
    'invalid and foreign writes must never persist');
  } finally {
    if (ownerConnected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally {
        await owner.end();
      }
    }
    if (runtimeConnected) await runtime.end();
  }
});
