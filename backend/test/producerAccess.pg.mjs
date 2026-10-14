// Disposable integration test: proves producer grants constrain real HTTP endpoints
// within one tenant, not just cross-tenant RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Producer access gate requires a disposable test database.');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'ci-producer-access-session-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { Client } = pg;

test('producer sees only expressly granted farms and fields; admin can grant and revoke', async (t) => {
  const owner = new Client({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const ids = { tenants: [], users: [] };
  let connected = false;

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  try {
    await owner.connect();
    connected = true;
    const { rows: [{ name }] } = await owner.query('SELECT current_database() AS name');
    assert.match(name, /(?:^|[_-])test(?:$|[_-])/i, 'Disposable _test database required');
    const { rows: [plan] } = await owner.query("SELECT id FROM plans WHERE code = 'starter'");
    assert.ok(plan);
    async function insert(sql, params) {
      return (await owner.query(sql, params)).rows[0].id;
    }
    const tenantA = await insert(
      "INSERT INTO tenants (plan_id, name, slug, status) VALUES ($1, $2, $3, 'active') RETURNING id",
      [plan.id, 'Producer scope A', `producer-scope-a-${suffix}`]
    );
    ids.tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants (plan_id, name, slug, status) VALUES ($1, $2, $3, 'active') RETURNING id",
      [plan.id, 'Producer scope B', `producer-scope-b-${suffix}`]
    );
    ids.tenants.push(tenantB);

    const adminId = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ($1,$2,'fixture') RETURNING id",
      ['Test Tenant Admin', `admin-${suffix}@example.test`]
    );
    ids.users.push(adminId);
    const viewerId = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ($1,$2,'fixture') RETURNING id",
      ['Test Producer Viewer', `viewer-${suffix}@example.test`]
    );
    ids.users.push(viewerId);

    await owner.query(
      "INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES ($1,$2,'tenant_admin','active'), ($1,$3,'producer_viewer','active')",
      [tenantA, adminId, viewerId]
    );
    await owner.query(
      "INSERT INTO tenant_modules (tenant_id,module_code,is_enabled,source) VALUES ($1,'gis',true,'plan'),($2,'gis',true,'plan')",
      [tenantA, tenantB]
    );
    const producerA1 = await insert('INSERT INTO producers (tenant_id,name) VALUES ($1,$2) RETURNING id',
      [tenantA, `Producer A1 ${suffix}`]);
    const producerA2 = await insert('INSERT INTO producers (tenant_id,name) VALUES ($1,$2) RETURNING id',
      [tenantA, `Producer A2 ${suffix}`]);
    const producerB = await insert('INSERT INTO producers (tenant_id,name) VALUES ($1,$2) RETURNING id',
      [tenantB, `Producer B ${suffix}`]);
    const farmA1 = await insert('INSERT INTO farms (tenant_id,producer_id,name) VALUES ($1,$2,$3) RETURNING id',
      [tenantA, producerA1, `Farm A1 ${suffix}`]);
    const farmA2 = await insert('INSERT INTO farms (tenant_id,producer_id,name) VALUES ($1,$2,$3) RETURNING id',
      [tenantA, producerA2, `Farm A2 ${suffix}`]);
    const farmB = await insert('INSERT INTO farms (tenant_id,producer_id,name) VALUES ($1,$2,$3) RETURNING id',
      [tenantB, producerB, `Farm B ${suffix}`]);
    const fieldA1 = await insert('INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id',
      [tenantA, farmA1, `Field A1 ${suffix}`]);
    const fieldA2 = await insert('INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id',
      [tenantA, farmA2, `Field A2 ${suffix}`]);
    const fieldB = await insert('INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id',
      [tenantB, farmB, `Field B ${suffix}`]);

    function token(userId, roleCode) {
      return signSession({ sub: userId, role_code: roleCode, tenant_id: tenantA });
    }
    const adminToken = token(adminId, 'tenant_admin');
    const viewerToken = token(viewerId, 'producer_viewer');
    async function request(path, authToken = viewerToken, method = 'GET', data = undefined, tenant = tenantA) {
      const response = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'x-tenant-id': tenant,
          ...(data ? { 'Content-Type': 'application/json' } : {})
        },
        ...(data ? { body: JSON.stringify(data) } : {})
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json()
      };
    }

    for (const path of ['/farms/producers', '/farms', '/fields']) {
      const result = await request(path);
      assert.equal(result.status, 200, path);
      assert.deepEqual(result.body.data, [], path);
    }
    assert.equal((await request(`/farms/${farmA1}`)).status, 404);
    assert.equal((await request(`/fields/${fieldA1}`)).status, 404);
    assert.equal((await request(`/farms/producers/${producerA1}/access`, viewerToken, 'POST', { user_id: viewerId })).status, 403);
    assert.equal((await request(`/farms/producers/${producerB}/access`, adminToken, 'POST', { user_id: viewerId })).status, 404);

    const granted = await request(`/farms/producers/${producerA1}/access`, adminToken, 'POST', { user_id: viewerId });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    assert.equal((await request(`/farms/producers/${producerA1}/access`, adminToken, 'POST', { user_id: viewerId })).status, 200);

    const producers = await request('/farms/producers');
    assert.deepEqual(producers.body.data.map(p => p.id), [producerA1]);
    assert.deepEqual(Object.keys(producers.body.data[0]).sort(), ['id', 'name']);
    const farms = await request('/farms');
    assert.deepEqual(farms.body.data.map(p => p.id), [farmA1]);
    const fields = await request('/fields');
    assert.deepEqual(fields.body.data.map(p => p.id), [fieldA1]);
    assert.equal((await request(`/farms/${farmA1}`)).status, 200);
    assert.equal((await request(`/fields/${fieldA1}`)).status, 200);
    assert.equal((await request(`/farms/${farmA2}`)).status, 404);
    assert.equal((await request(`/fields/${fieldA2}`)).status, 404);
    assert.equal((await request(`/fields/${fieldB}`)).status, 404);
    assert.equal((await request(`/farms/${farmB}`)).status, 404);

    const listed = await request(`/farms/producers/${producerA1}/access`, adminToken);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.data.map(a => a.user_id), [viewerId]);
    const revoked = await request(`/farms/producers/${producerA1}/access/${viewerId}`, adminToken, 'DELETE');
    assert.equal(revoked.status, 204);
    assert.deepEqual((await request('/fields')).body.data, []);
    assert.equal((await request(`/fields/${fieldA1}`)).status, 404);

    const mismatchedTenant = await request('/farms', viewerToken, 'GET', undefined, tenantB);
    assert.equal(mismatchedTenant.status, 403);
  } finally {
    if (connected) {
      try {
        if (ids.tenants.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [ids.tenants]);
        if (ids.users.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
      } finally {
        await owner.end();
      }
    }
  }
});
