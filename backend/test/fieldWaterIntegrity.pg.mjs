// 0U.9 — GIS field creation and irrigation interval validation in real PostGIS.
// Disposable migrated/seeded *_test DB; HTTP service runs as a non-owner FORCE RLS role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !runtimeUrl) throw new Error('fieldWaterIntegrity needs disposable *_test owner/app URLs');
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'field-water-integrity-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('field parent is tenant scoped and irrigation cannot end before it starts', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const appDb = new pg.Client({ connectionString: runtimeUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerConnected = false, runtimeConnected = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;
  async function send(path, token, tenantId, method = 'POST', body) {
    const response = await fetch(endpoint + path, {
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
    await appDb.connect();
    runtimeConnected = true;
    const [{ database }] = (await owner.query('SELECT current_database() AS database')).rows;
    const [{ app_database: appDatabase, ...runtimeRole }] = (await appDb.query(`
      SELECT current_database() AS app_database, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(database, /(?:^|[_-])test(?:$|[_-])/i, 'refuse non-test database');
    assert.equal(appDatabase, database);
    assert.ok(isSafeRuntimeDbRole(runtimeRole), 'runtime must not own or bypass RLS');
    const protectedTables = (await owner.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY[
        'public.farms'::regclass,'public.fields'::regclass,
        'public.irrigation_events'::regclass])
    `)).rows;
    assert.equal(protectedTables.length, 3);
    for (const table of protectedTables) {
      assert.ok(table.relrowsecurity && table.relforcerowsecurity, table.relname);
    }

    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const tenantA = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Field water A',$2,'active') RETURNING id",
      [plan.id, `field-water-a-${suffix}`]);
    tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Field water B',$2,'active') RETURNING id",
      [plan.id, `field-water-b-${suffix}`]);
    tenants.push(tenantB);

    async function member(tenantId, label, roleCode) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label, `field-water-${suffix}-${label.replaceAll(' ', '-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, id, roleCode]);
      return signSession({ sub: id, role_code: roleCode, tenant_id: tenantId });
    }
    const adminA = await member(tenantA, 'admin a', 'tenant_admin');
    const coordinatorA = await member(tenantA, 'coordinator a', 'agronomic_coordinator');
    const contractorA = await member(tenantA, 'contractor a', 'contractor');
    const adminB = await member(tenantB, 'admin b', 'tenant_admin');
    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
      "($1,'gis',true,'plan'),($2,'gis',true,'plan')", [tenantA, tenantB]);
    const farmA = await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantA, `Farm A ${suffix}`]);
    const farmB = await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantB, `Farm B ${suffix}`]);

    const foreign = await send('/fields', adminA, tenantA, 'POST',
      { name: 'Cross-tenant field', farm_id: farmB });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json));
    assert.equal(foreign.json.error.code, 'FIELD_FARM_NOT_FOUND');

    const unknown = await send('/fields', adminA, tenantA, 'POST',
      { name: 'Unknown-farm field', farm_id: randomUUID() });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    assert.equal(unknown.json.error.code, 'FIELD_FARM_NOT_FOUND');

    const unauthorized = await send('/fields', contractorA, tenantA, 'POST',
      { name: 'Unauthorized field', farm_id: farmA });
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.json));

    const created = await send('/fields', adminA, tenantA, 'POST',
      { name: `New field ${suffix}`, farm_id: farmA, area_hectares: 14.5 });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const fieldA = created.json.data.id;
    assert.equal(created.json.data.farm_id, farmA);

    const otherCreated = await send('/fields', adminB, tenantB, 'POST',
      { name: `Other field ${suffix}`, farm_id: farmB });
    assert.equal(otherCreated.status, 201, JSON.stringify(otherCreated.json));
    const fieldB = otherCreated.json.data.id;
    const started_at = '2026-10-21T10:00:00.000Z';
    const finished_at = '2026-10-21T10:30:00.000Z';
    const earlier_at = '2026-10-21T09:59:59.000Z';

    const backward = await send(`/fields/${fieldA}/irrigation`, coordinatorA, tenantA,
      'POST', { started_at, ended_at: earlier_at, amount_mm: 12, source: 'manual' });
    assert.equal(backward.status, 422, JSON.stringify(backward.json));
    assert.equal(backward.json.error.code, 'VALIDATION_ERROR');
    assert.ok(backward.json.error.details.fieldErrors.ended_at.length > 0);

    const negative = await send(`/fields/${fieldA}/irrigation`, coordinatorA, tenantA,
      'POST', { started_at, ended_at: finished_at, amount_mm: -1 });
    assert.equal(negative.status, 422, JSON.stringify(negative.json));

    const missingField = await send(`/fields/${randomUUID()}/irrigation`,
      adminA, tenantA, 'POST', { started_at, amount_mm: 5 });
    assert.equal(missingField.status, 404, JSON.stringify(missingField.json));

    const foreignField = await send(`/fields/${fieldB}/irrigation`,
      adminA, tenantA, 'POST', { started_at, amount_mm: 5 });
    assert.equal(foreignField.status, 404, JSON.stringify(foreignField.json));

    const deniedWater = await send(`/fields/${fieldA}/irrigation`,
      contractorA, tenantA, 'POST', { started_at, amount_mm: 5 });
    assert.equal(deniedWater.status, 403, JSON.stringify(deniedWater.json));

    const sameTime = await send(`/fields/${fieldA}/irrigation`,
      coordinatorA, tenantA, 'POST', { started_at, ended_at: started_at, amount_mm: 0 });
    assert.equal(sameTime.status, 201, JSON.stringify(sameTime.json));
    const valid = await send(`/fields/${fieldA}/irrigation`,
      adminA, tenantA, 'POST', { started_at, ended_at: finished_at, amount_mm: 12.5 });
    assert.equal(valid.status, 201, JSON.stringify(valid.json));
    const openEnded = await send(`/fields/${fieldA}/irrigation`,
      adminA, tenantA, 'POST', { started_at, amount_mm: 2.5 });
    assert.equal(openEnded.status, 201, JSON.stringify(openEnded.json));

    const rows = (await owner.query(
      'SELECT id,tenant_id,field_id,amount_mm,started_at,ended_at FROM irrigation_events WHERE tenant_id=$1 ORDER BY amount_mm',
      [tenantA])).rows;
    assert.equal(rows.length, 3, 'invalid intervals and foreign fields must never persist');
    assert.deepEqual(rows.map(row => Number(row.amount_mm)), [0, 2.5, 12.5]);
    assert.deepEqual(rows.map(row => row.field_id), [fieldA, fieldA, fieldA]);
    assert.equal(rows.find(row => Number(row.amount_mm) === 2.5).ended_at, null);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM fields WHERE tenant_id=$1', [tenantA])).rows[0].n, 1);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM irrigation_events WHERE tenant_id=$1',
      [tenantB])).rows[0].n, 0);
  } finally {
    if (ownerConnected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally {
        await owner.end();
      }
    }
    if (runtimeConnected) await appDb.end();
  }
});
