// Pilot 0U.17 — create farms only with same-tenant producers and WGS84 centroids.
// Real Express HTTP, non-owner FORCE RLS PostGIS; disposable *_test databases ONLY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !appUrl) throw new Error('farmCreationIntegrity requires disposable *_test PostGIS URLs');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'farm-creation-integrity-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('farm producer and centroid remain tenant-scoped and geographically valid', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const key = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerConnected = false, runtimeConnected = false;
  const insert = async (sql, args) => (await owner.query(sql, args)).rows[0].id;
  async function request(path, token, tenant, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenant,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, json: await response.json() };
  }
  const point = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] });
  const valid = point(-58.47, -34.92);

  try {
    await owner.connect(); ownerConnected = true;
    await runtime.connect(); runtimeConnected = true;
    const [{ db }] = (await owner.query('SELECT current_database() AS db')).rows;
    const [{ app_db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS app_db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i, 'must not use a real business database');
    assert.equal(appDb, db);
    assert.ok(isSafeRuntimeDbRole(role), 'runtime must not own or bypass RLS');
    const protectedTables = (await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.farms'::regclass,'public.producers'::regclass,
        'public.producer_access_grants'::regclass])
    `)).rows;
    assert.equal(protectedTables.length, 3);
    for (const row of protectedTables) {
      assert.ok(row.relrowsecurity && row.relforcerowsecurity, row.relname);
    }
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function tenant(name) {
      const id = await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, `Farm creation ${name}`, `farm-integrity-${name}-${key}`]);
      tenants.push(id);
      await owner.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES($1,'gis',true,'plan')",
        [id]);
      return id;
    }
    const a = await tenant('a');
    const b = await tenant('b');
    async function user(tenantId, name, roleCode) {
      const userId = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [name, `farm-integrity-${key}-${name.replaceAll(' ', '-')}@example.test`]);
      users.push(userId);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, userId, roleCode]);
      return { id: userId, token: signSession({
        sub: userId, role_code: roleCode, tenant_id: tenantId
      }) };
    }
    const adminA = await user(a, 'admin a', 'tenant_admin');
    const contractorA = await user(a, 'contractor a', 'contractor');
    const viewerA = await user(a, 'viewer a', 'producer_viewer');
    const adminB = await user(b, 'admin b', 'tenant_admin');
    const producerA = await insert(
      'INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [a, `Producer A ${key}`]);
    const producerA2 = await insert(
      'INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [a, `Producer A2 ${key}`]);
    const producerB = await insert(
      'INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [b, `Producer B ${key}`]);
    await owner.query(
      'INSERT INTO producer_access_grants(tenant_id,user_id,producer_id,granted_by) VALUES($1,$2,$3,$4)',
      [a, viewerA.id, producerA, adminA.id]);

    const foreign = await request('/farms', adminA.token, a, 'POST',
      { name: `Foreign ${key}`, producer_id: producerB, centroid: valid });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json));
    assert.equal(foreign.json.error.code, 'FARM_PRODUCER_NOT_FOUND');
    const absent = await request('/farms', adminA.token, a, 'POST',
      { name: `Absent ${key}`, producer_id: randomUUID(), centroid: valid });
    assert.equal(absent.status, 404, JSON.stringify(absent.json));
    assert.equal(absent.json.error.code, 'FARM_PRODUCER_NOT_FOUND');
    const forbidden = await request('/farms', contractorA.token, a, 'POST',
      { name: 'Unauthorized farm', producer_id: producerA, centroid: valid });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.json));

    const invalidPoints = [
      ['wrong-type', { type: 'Polygon', coordinates: [] }],
      ['lon-range', point(180.1, -34.92)],
      ['lat-range', point(-58.47, -90.1)],
      ['third-coordinate', { type: 'Point', coordinates: [-58.47, -34.92, 120] }],
      ['missing-coordinate', { type: 'Point', coordinates: [-58.47] }],
      ['wrong-srid', { ...valid, srid: 3857 }],
      ['string-coordinate', point('-58.47', -34.92)],
      ['unexpected-properties', { ...valid, latitude: -34.92 }],
      ['invalid-json', 'not GeoJSON']
    ];
    for (const [label, centroid] of invalidPoints) {
      const bad = await request('/farms', adminA.token, a, 'POST',
        { name: `Invalid ${label} ${key}`, producer_id: producerA, centroid });
      assert.equal(bad.status, 422, `${label}: ${JSON.stringify(bad.json)}`);
      assert.equal(bad.json.error.code, 'VALIDATION_ERROR', label);
    }

    const created = await request('/farms', adminA.token, a, 'POST',
      { name: `Valid ${key}`, producer_id: producerA, centroid: valid });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.data.id;
    assert.equal(created.json.data.producer_id, producerA);
    const stored = (await owner.query(`
      SELECT producer_id, ST_SRID(centroid) AS srid, ST_X(centroid) AS lon,
        ST_Y(centroid) AS lat FROM farms WHERE id=$1 AND tenant_id=$2
    `, [id, a])).rows[0];
    assert.equal(stored.producer_id, producerA);
    assert.equal(stored.srid, 4326);
    assert.equal(stored.lon, -58.47);
    assert.equal(stored.lat, -34.92);

    const visible = await request('/farms', viewerA.token, a);
    assert.equal(visible.status, 200, JSON.stringify(visible.json));
    assert.deepEqual(visible.json.data.map(farm => farm.id), [id]);

    const invalidPatch = await request(`/farms/${id}`, adminA.token, a, 'PATCH',
      { centroid: point(200, 0) });
    assert.equal(invalidPatch.status, 422, JSON.stringify(invalidPatch.json));
    const unchanged = (await owner.query(
      'SELECT ST_X(centroid) AS lon, ST_Y(centroid) AS lat FROM farms WHERE id=$1',
      [id])).rows[0];
    assert.deepEqual(unchanged, { lon: -58.47, lat: -34.92 });
    const moved = await request(`/farms/${id}`, adminA.token, a, 'PATCH',
      { centroid: point(-58.41, -34.81) });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));

    const reparent = await request(`/farms/${id}`, adminA.token, a, 'PATCH',
      { producer_id: producerA2 });
    assert.equal(reparent.status, 409, JSON.stringify(reparent.json));
    assert.equal(reparent.json.error.code, 'FARM_PRODUCER_IDENTITY_IMMUTABLE');

    const cleared = await request(`/farms/${id}`, adminA.token, a, 'PATCH',
      { centroid: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal((await owner.query(
      'SELECT centroid IS NULL AS empty, producer_id FROM farms WHERE id=$1',
      [id])).rows[0].empty, true);

    const unassigned = await request('/farms', adminA.token, a, 'POST',
      { name: `Unassigned ${key}`, producer_id: null });
    assert.equal(unassigned.status, 201, JSON.stringify(unassigned.json));
    const initialAssignment = await request(`/farms/${unassigned.json.data.id}`,
      adminA.token, a, 'PATCH', { producer_id: producerA2 });
    assert.equal(initialAssignment.status, 200, JSON.stringify(initialAssignment.json));
    const ownOther = await request('/farms', adminB.token, b, 'POST',
      { name: `Other ${key}`, producer_id: producerB, centroid: valid });
    assert.equal(ownOther.status, 201, JSON.stringify(ownOther.json));
    const foreignPatch = await request(`/farms/${ownOther.json.data.id}`, adminA.token, a,
      'PATCH', { centroid: valid });
    assert.equal(foreignPatch.status, 404, JSON.stringify(foreignPatch.json));

    const counts = (await owner.query(
      'SELECT tenant_id, count(*)::int AS n FROM farms WHERE tenant_id=ANY($1::uuid[]) GROUP BY tenant_id',
      [[a, b]])).rows;
    assert.equal(counts.find(row => row.tenant_id === a)?.n, 2);
    assert.equal(counts.find(row => row.tenant_id === b)?.n, 1);
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
