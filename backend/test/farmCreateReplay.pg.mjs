// 0U.19 — stable farm identity under HTTP retries with real disposable PostGIS.
// Exercises tenant-scoped INSERT/read and concurrent attempts with non-owner FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !runtimeUrl) {
  throw new Error('farmCreateReplay requires disposable PostgreSQL *_test owner/app URLs');
}
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'farm-replay-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('retries preserve farm, producer grants and WGS84 coordinates under FORCE RLS', async t => {
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
  const unique = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerConnected = false, appConnected = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;
  async function call(path, token, tenant, method = 'POST', data) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenant,
        ...(data === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    return { status: response.status,
      body: response.status === 204 ? null : await response.json() };
  }
  const centroid = { type: 'Point', coordinates: [-58.47, -34.92] };
  const samePointWithSrid = { ...centroid, srid: 4326 };

  try {
    await owner.connect(); ownerConnected = true;
    await runtime.connect(); appConnected = true;
    const [{ name: ownerDb }] = (await owner.query('SELECT current_database() AS name')).rows;
    const [{ db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(ownerDb, /(?:^|[_-])test(?:$|[_-])/i, 'never mutate a business database');
    assert.equal(appDb, ownerDb);
    assert.ok(isSafeRuntimeDbRole(role), 'runtime must be non-owner without BYPASSRLS');
    const rls = (await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.farms'::regclass,'public.producers'::regclass])
    `)).rows;
    assert.equal(rls.length, 2);
    for (const table of rls) assert.ok(table.relrowsecurity && table.relforcerowsecurity);

    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function makeTenant(suffix) {
      const id = await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, `Farm replay ${suffix}`, `farm-replay-${suffix}-${unique}`]);
      tenants.push(id);
      await owner.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES($1,'gis',true,'plan')",
        [id]);
      return id;
    }
    const a = await makeTenant('a');
    const b = await makeTenant('b');

    async function member(tid, label, roleCode) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label, `farm-replay-${unique}-${label.replaceAll(' ', '-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid, id, roleCode]);
      return signSession({ sub: id, role_code: roleCode, tenant_id: tid });
    }
    const adminA = await member(a, 'admin a', 'tenant_admin');
    const viewerA = await member(a, 'viewer a', 'producer_viewer');
    const adminB = await member(b, 'admin b', 'tenant_admin');
    const producerA = await insert(
      'INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [a, `Producer A ${unique}`]);
    const producerB = await insert(
      'INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [b, `Producer B ${unique}`]);

    const input = {
      name: `Sede piloto ${unique}`, producer_id: producerA,
      locality: 'La Plata', province: 'Buenos Aires', country: 'Argentina',
      notes: 'Trabajo de campo', centroid
    };
    const first = await call('/farms', adminA, a, 'POST', input);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    const id = first.body.data.id;

    const retry = await call('/farms', adminA, a, 'POST', { ...input, centroid: samePointWithSrid });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.data.id, id);

    for (const [label, change] of [
      ['producer', { producer_id: null }],
      ['notes', { notes: 'Otra campaña' }],
      ['locality', { locality: 'Pergamino' }],
      ['coordinates', { centroid: { type: 'Point', coordinates: [-58.46, -34.92] } }],
      ['country', { country: 'Uruguay' }]
    ]) {
      const conflict = await call('/farms', adminA, a, 'POST', { ...input, ...change });
      assert.equal(conflict.status, 409, `${label}: ${JSON.stringify(conflict.body)}`);
      assert.equal(conflict.body.error.code, 'FARM_CREATE_CONFLICT');
    }

    const foreign = await call('/farms', adminA, a, 'POST', { ...input, producer_id: producerB });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(foreign.body.error.code, 'FARM_PRODUCER_NOT_FOUND');

    const denied = await call('/farms', viewerA, a, 'POST', input);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    const other = await call('/farms', adminB, b, 'POST',
      { ...input, producer_id: producerB });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.notEqual(other.body.data.id, id);
    assert.equal(other.body.replayed, false);

    const noProducer = {
      name: `Sin productor ${unique}`, producer_id: null,
      country: 'Argentina', centroid: null
    };
    const unassigned = await call('/farms', adminA, a, 'POST', noProducer);
    assert.equal(unassigned.status, 201, JSON.stringify(unassigned.body));
    const unassignedRetry = await call('/farms', adminA, a, 'POST',
      { name: noProducer.name }); // null and missing are the same absent producer.
    assert.equal(unassignedRetry.status, 200, JSON.stringify(unassignedRetry.body));
    assert.equal(unassignedRetry.body.data.id, unassigned.body.data.id);

    const initial = await call(`/farms/${unassigned.body.data.id}`,
      adminA, a, 'PATCH', { producer_id: producerA });
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const staleRetry = await call('/farms', adminA, a, 'POST', noProducer);
    assert.equal(staleRetry.status, 409, 'a stale original create must not undo producer assignment');
    assert.equal(staleRetry.body.error.code, 'FARM_CREATE_CONFLICT');

    const racing = { name: `Racing ${unique}`, producer_id: producerA };
    const pair = await Promise.all([
      call('/farms', adminA, a, 'POST', racing),
      call('/farms', adminA, a, 'POST', racing)
    ]);
    assert.deepEqual(pair.map(x => x.status).sort(), [200, 201],
      `concurrent retry: ${JSON.stringify(pair)}`);
    assert.equal(pair[0].body.data.id, pair[1].body.data.id);

    const persisted = (await owner.query(`
      SELECT producer_id, locality, province, country, notes,
        ST_SRID(centroid) AS srid, ST_X(centroid) AS lon,
        ST_Y(centroid) AS lat FROM farms WHERE tenant_id=$1 AND id=$2
    `, [a, id])).rows[0];
    assert.deepEqual(persisted, {
      producer_id: producerA, locality: 'La Plata', province: 'Buenos Aires',
      country: 'Argentina', notes: 'Trabajo de campo',
      srid: 4326, lon: -58.47, lat: -34.92
    });
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM farms WHERE tenant_id=$1', [a])).rows[0].n, 3);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM farms WHERE tenant_id=$1', [b])).rows[0].n, 1);
  } finally {
    if (ownerConnected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await owner.end(); }
    }
    if (appConnected) await runtime.end();
  }
});
