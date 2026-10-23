// 0U.10: imagery provenance, tenant-scoped field validation and retry safety.
// Real HTTP + PostGIS disposable *_test with non-owner FORCE RLS runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !runtimeUrl) throw new Error('imageryLayerIntegrity requires disposable *_test owner/runtime DB URLs');
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'imagery-layer-integrity-test-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('imagery layers never attach to foreign fields or rewrite metadata on HTTP retry', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: runtimeUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/imagery/layers`;
  const salt = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let connectedOwner = false, connectedRuntime = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;
  async function req(token, tenantId, method='POST', data) {
    const response = await fetch(base, {
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
    await owner.connect(); connectedOwner = true;
    await runtime.connect(); connectedRuntime = true;
    const [{ db }] = (await owner.query('SELECT current_database() AS db')).rows;
    const [{ app_db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS app_db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(appDb, db);
    assert.ok(isSafeRuntimeDbRole(role), 'runtime must be non-owner without bypass RLS');
    const policies = (await owner.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.fields'::regclass,
        'public.satellite_layers'::regclass])
    `)).rows;
    assert.equal(policies.length, 2);
    for (const item of policies) {
      assert.ok(item.relrowsecurity && item.relforcerowsecurity, item.relname);
    }
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const tenantA = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Imagery integrity A',$2,'active') RETURNING id",
      [plan.id, `imagery-integrity-a-${salt}`]); tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Imagery integrity B',$2,'active') RETURNING id",
      [plan.id, `imagery-integrity-b-${salt}`]); tenants.push(tenantB);
    async function user(tid, label, roleCode) {
      const userId = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label, `imagery-integrity-${salt}-${label.replaceAll(' ','-')}@example.test`]);
      users.push(userId);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid,userId,roleCode]);
      return signSession({ sub: userId, role_code: roleCode, tenant_id: tid });
    }
    const adminA = await user(tenantA,'admin a','tenant_admin');
    const coordinatorA = await user(tenantA,'coordinator a','agronomic_coordinator');
    const contractorA = await user(tenantA,'contractor a','contractor');
    const adminB = await user(tenantB,'admin b','tenant_admin');
    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
      "($1,'imagery',true,'plan'),($2,'imagery',true,'plan')",
      [tenantA,tenantB]);

    async function createField(tid,label) {
      const farmId = await insert(
        'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tid,`Imagery farm ${label} ${salt}`]);
      return insert(
        'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tid,farmId,`Imagery field ${label} ${salt}`]);
    }
    const fieldA = await createField(tenantA,'A');
    const fieldB = await createField(tenantB,'B');
    const layer = {
      field_id: fieldA,
      provider: 'pilot-satellite',
      layer_type: 'ndvi',
      captured_at: '2026-10-22T09:00:00.000Z',
      storage_key: `private-imagery/${salt}/ndvi.tif`,
      metadata: { device: 'test', cloud: { percentage: 5, quality: 'clear' } }
    };
    const crossTenant = await req(adminA, tenantA, 'POST', { ...layer, field_id: fieldB });
    assert.equal(crossTenant.status, 404, JSON.stringify(crossTenant.json));
    assert.equal(crossTenant.json.error.code, 'IMAGERY_FIELD_NOT_FOUND');
    const nonexistent = await req(adminA, tenantA, 'POST', { ...layer, field_id: randomUUID() });
    assert.equal(nonexistent.status, 404, JSON.stringify(nonexistent.json));
    assert.equal(nonexistent.json.error.code, 'IMAGERY_FIELD_NOT_FOUND');
    const unauthorized = await req(contractorA, tenantA, 'POST', layer);
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.json));

    const created = await req(adminA, tenantA, 'POST', layer);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const layerId = created.json.data.id;
    const replay = await req(coordinatorA, tenantA, 'POST', {
      ...layer, metadata: { cloud: { quality: 'clear', percentage: 5 }, device: 'test' }
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.data.id, layerId);
    assert.equal(replay.json.replayed, true);
    for (const payload of [
      { ...layer, provider: 'different-satellite' },
      { ...layer, storage_key: `private-imagery/${salt}/other.tif` },
      { ...layer, metadata: { device: 'test', cloud: { percentage: 90 } } }
    ]) {
      const denied = await req(adminA, tenantA, 'POST', payload);
      assert.equal(denied.status, 409, JSON.stringify(denied.json));
      assert.equal(denied.json.error.code, 'IMAGERY_LAYER_CONFLICT');
    }
    const anotherCapture = await req(coordinatorA, tenantA, 'POST', {
      ...layer, captured_at: '2026-10-22T10:00:00.000Z',
      storage_key: `private-imagery/${salt}/second.tif`
    });
    assert.equal(anotherCapture.status, 201, JSON.stringify(anotherCapture.json));
    const otherOrg = await req(adminB, tenantB, 'POST', {
      ...layer, field_id: fieldB, storage_key: `private-imagery/${salt}/other-tenant.tif`
    });
    assert.equal(otherOrg.status, 201, JSON.stringify(otherOrg.json));
    const listing = await req(adminA, tenantA, 'GET');
    assert.equal(listing.status, 200, JSON.stringify(listing.json));
    assert.deepEqual(new Set(listing.json.data.map(row => row.id)),
      new Set([layerId, anotherCapture.json.data.id]));

    const persisted = (await owner.query(
      'SELECT id,tenant_id,field_id,provider,storage_key,metadata FROM satellite_layers WHERE tenant_id=$1 ORDER BY captured_at',
      [tenantA])).rows;
    assert.equal(persisted.length, 2, 'retries and invalid foreign references must not create extra rows');
    assert.equal(persisted[0].id, layerId);
    assert.equal(persisted[0].field_id, fieldA);
    assert.equal(persisted[0].provider, layer.provider);
    assert.equal(persisted[0].storage_key, layer.storage_key);
    assert.deepEqual(persisted[0].metadata, layer.metadata);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM satellite_layers WHERE tenant_id=$1',
      [tenantB])).rows[0].n, 1);
  } finally {
    if (connectedOwner) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await owner.end(); }
    }
    if (connectedRuntime) await runtime.end();
  }
});
