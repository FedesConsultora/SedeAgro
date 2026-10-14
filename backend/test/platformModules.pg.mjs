// Platform operators manage another tenant's module grants under FORCE RLS,
// without switching the outer request's transaction to an independently committing one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Platform module gate requires disposable test PostgreSQL URLs.');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'ci-platform-module-test-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { Client } = pg;

test('platform module overrides honor target tenant RLS and do not leak into actor tenant', async (t) => {
  const owner = new Client({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let connected = false;
  let tenantA;
  let tenantB;
  let operatorId;
  let ordinaryId;
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sequelize.close();
  });

  try {
    await owner.connect();
    connected = true;
    const { rows: [{ db }] } = await owner.query('SELECT current_database() AS db');
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);

    const { rows: [plan] } = await owner.query("SELECT id FROM plans WHERE code = 'starter'");
    assert.ok(plan);
    async function id(sql, params) {
      return (await owner.query(sql, params)).rows[0].id;
    }
    tenantA = await id("INSERT INTO tenants (plan_id,name,slug,status) VALUES ($1,$2,$3,'active') RETURNING id",
      [plan.id, 'Platform actor tenant', `platform-a-${suffix}`]);
    tenantB = await id("INSERT INTO tenants (plan_id,name,slug,status) VALUES ($1,$2,$3,'active') RETURNING id",
      [plan.id, 'Platform target tenant', `platform-b-${suffix}`]);
    operatorId = await id("INSERT INTO users (full_name,email,password_hash,is_platform_admin) VALUES ($1,$2,'fixture',true) RETURNING id",
      ['Platform operator', `platform-${suffix}@example.test`]);
    ordinaryId = await id("INSERT INTO users (full_name,email,password_hash) VALUES ($1,$2,'fixture') RETURNING id",
      ['Ordinary member', `ordinary-${suffix}@example.test`]);
    await owner.query("INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES ($1,$2,'tenant_admin','active'),($1,$3,'tenant_admin','active')",
      [tenantA, operatorId, ordinaryId]);
    await owner.query("INSERT INTO tenant_modules (tenant_id,module_code,is_enabled,source) VALUES ($1,'gis',true,'plan'),($2,'gis',false,'plan')",
      [tenantA, tenantB]);

    const root = `http://127.0.0.1:${server.address().port}/api/v1`;
    const operatorToken = signSession({ sub: operatorId, tenant_id: tenantA, role_code: 'tenant_admin' });
    const ordinaryToken = signSession({ sub: ordinaryId, tenant_id: tenantA, role_code: 'tenant_admin' });
    async function request(path, token, method = 'GET', body = undefined) {
      const resp = await fetch(root + path, {
        method,
        headers: {
          'x-tenant-id': tenantA, Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { status: resp.status, body: await resp.json() };
    }

    const initial = await request(`/platform/tenants/${tenantB}/modules`, operatorToken);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.ok(!initial.body.data.enabled.includes('gis'));

    const denied = await request(`/platform/tenants/${tenantB}/modules`, ordinaryToken, 'POST', {
      module_code: 'gis', is_enabled: true
    });
    assert.equal(denied.status, 403);

    const enabled = await request(`/platform/tenants/${tenantB}/modules`, operatorToken, 'POST', {
      module_code: 'gis', is_enabled: true
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.data.source, 'override');

    const after = await request(`/platform/tenants/${tenantB}/modules`, operatorToken);
    assert.equal(after.status, 200);
    assert.ok(after.body.data.enabled.includes('gis'));

    const self = await request('/auth/me', operatorToken);
    assert.equal(self.status, 200);
    assert.ok(self.body.entitlements.includes('gis'),
      'Platform target-tenant switch must not overwrite actor tenant entitlements');

    const { rows: modules } = await owner.query(
      "SELECT tenant_id, is_enabled, source FROM tenant_modules WHERE module_code = 'gis' AND tenant_id = ANY($1::uuid[]) ORDER BY tenant_id",
      [[tenantA, tenantB]]
    );
    assert.equal(modules.length, 2);
    assert.equal(modules.find(m => m.tenant_id === tenantA).source, 'plan');
    assert.equal(modules.find(m => m.tenant_id === tenantB).source, 'override');
  } finally {
    if (connected) {
      try {
        if (tenantA || tenantB) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])',
          [[tenantA, tenantB].filter(Boolean)]);
        if (operatorId || ordinaryId) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])',
          [[operatorId, ordinaryId].filter(Boolean)]);
      } finally { await owner.end(); }
    }
  }
});
