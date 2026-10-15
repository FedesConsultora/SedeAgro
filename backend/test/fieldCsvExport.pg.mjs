// HTTP acceptance with PostGIS/RLS and two tenants. Disposable *_test only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !appUrl) throw new Error('A disposable *_test PostGIS database is required.');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'field-csv-ci-test-only-secret';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');

test('field CSV exports authorized tenant data, excludes other tenant and rejects unbounded/invalid ranges', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const ids = { tenants: [], users: [] };
  const rand = randomUUID().slice(0, 10);
  let connected = false;
  try {
    await owner.connect();
    connected = true;
    const { rows: [{ database }] } = await owner.query('SELECT current_database() AS database');
    assert.match(database, /(?:^|[_-])test(?:$|[_-])/i, 'never write a non-test database');
    const plan = (await owner.query("SELECT id FROM plans WHERE code = 'starter'")).rows[0]?.id;
    const crop = (await owner.query("SELECT id FROM crop_types WHERE code = 'soy'")).rows[0]?.id;
    assert.ok(plan && crop);

    async function add(sql, params) { return (await owner.query(sql, params)).rows[0].id; }
    async function tenant(label) {
      const id = await add(
        "INSERT INTO tenants(name,slug,plan_id,status) VALUES ($1,$2,$3,'active') RETURNING id",
        [label, `csv-${label.toLowerCase()}-${rand}`, plan]
      );
      ids.tenants.push(id);
      await owner.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES ($1,'reports',true,'plan')",
        [id]
      );
      return id;
    }
    async function user(label) {
      const id = await add(
        "INSERT INTO users(full_name,email,password_hash) VALUES ($1,$2,'fixture') RETURNING id",
        [label, `csv-${label.toLowerCase()}-${rand}@example.test`]
      );
      ids.users.push(id);
      return id;
    }
    const tenantA = await tenant('Alpha');
    const tenantB = await tenant('Bravo');
    const coordinator = await user('Coordinator');
    const scout = await user('Scout');
    await owner.query(
      "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES ($1,$2,'agronomic_coordinator','active'),($1,$3,'scout','active')",
      [tenantA, coordinator, scout]
    );
    async function field(tenantId, label) {
      const farm = await add(
        'INSERT INTO farms(tenant_id,name) VALUES ($1,$2) RETURNING id',
        [tenantId, label]
      );
      const fieldId = await add(
        'INSERT INTO fields(tenant_id,farm_id,name,area_hectares) VALUES ($1,$2,$3,12.5) RETURNING id',
        [tenantId, farm, label + ' lote']
      );
      const campaign = await add(
        "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES ($1,$2,2026,'2026-01-01') RETURNING id",
        [tenantId, 'CSV campaign']
      );
      const campaignField = await add(
        'INSERT INTO campaign_fields(tenant_id,campaign_id,field_id,crop_type_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [tenantId, campaign, fieldId, crop]
      );
      const run = await add(
        "INSERT INTO scouting_runs(tenant_id,campaign_field_id,status) VALUES ($1,$2,'planned') RETURNING id",
        [tenantId, campaignField]
      );
      return { fieldId, run };
    }
    const a = await field(tenantA, 'Alpha secret');
    const b = await field(tenantB, 'Bravo secret');
    await owner.query(
      "INSERT INTO scouting_observations(tenant_id,scouting_run_id,field_id,observed_by,observation_type,severity,notes,observed_at) VALUES ($1,$2,$3,$4,'weed','high',$5,'2026-10-15T11:00:00Z')",
      [tenantA, a.run, a.fieldId, coordinator, '=HYPERLINK("bad")']
    );
    await owner.query(
      "INSERT INTO scouting_observations(tenant_id,scouting_run_id,field_id,observation_type,notes,observed_at) VALUES ($1,$2,$3,'general',$4,'2026-10-14T11:00:00Z')",
      [tenantB, b.run, b.fieldId, 'DO NOT LEAK BRAVO NOTES']
    );
    await owner.query(
      "INSERT INTO work_orders(tenant_id,field_id,title,type,status,priority,created_at) VALUES ($1,$2,$3,'inspection','draft','urgent','2026-10-15T10:00:00Z')",
      [tenantA, a.fieldId, '@SUM(1)']
    );
    const token = signSession({ sub: coordinator, tenant_id: tenantA, role_code: 'agronomic_coordinator' });
    const restricted = signSession({ sub: scout, tenant_id: tenantA, role_code: 'scout' });
    const base = `http://127.0.0.1:${server.address().port}/api/v1/reports/field/${a.fieldId}/export.csv`;
    const get = (url, bearer = token) => fetch(url, { headers: {
      authorization: `Bearer ${bearer}`, 'x-tenant-id': tenantA
    } });
    const result = await get(base + '?from=2026-10-15&to=2026-10-15');
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    const json = await result.json();
    assert.equal(json.data.counts.observations, 1);
    assert.equal(json.data.counts.workOrders, 1);
    assert.equal(json.data.mimeType, 'text/csv;charset=utf-8');
    assert.ok(json.data.csv.includes('"\'=HYPERLINK(""bad"")"'));
    assert.ok(json.data.csv.includes('"\'@SUM(1)"'));
    assert.ok(!json.data.csv.includes('DO NOT LEAK BRAVO'));
    assert.ok(!json.data.csv.includes('Bravo secret'));
    assert.match(json.data.filename, /^reporte-lote-[0-9a-f-]{36}\.csv$/);

    for (const format of ['pdf', 'xlsx']) {
      const url = base.replace('.csv', '.' + format);
      const response = await get(url + '?from=2026-10-15&to=2026-10-15');
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const doc = (await response.json()).data;
      assert.deepEqual(doc.counts, { observations: 1, workOrders: 1 });
      assert.equal(doc.period.from, '2026-10-15');
      assert.equal(doc.period.to, '2026-10-15');
      assert.ok(doc.filename.endsWith('.' + format));
      const file = Buffer.from(doc.content_base64, 'base64');
      assert.equal(file.length, doc.size_bytes);
      assert.ok(file.length > 250 && file.length < 3 * 1024 * 1024);
      const signature = format === 'pdf' ? Buffer.from([37,80,68,70]) : Buffer.from([80,75,3,4]);
      assert.deepEqual(file.subarray(0,4), signature);
      const bytesAsText = file.toString(format === 'pdf' ? 'latin1' : 'utf8');
      assert.ok(bytesAsText.includes('HYPERLINK'));
      assert.ok(!bytesAsText.includes('DO NOT LEAK BRAVO'));
      assert.ok(!bytesAsText.includes('Bravo secret'));
      assert.equal((await get(url, restricted)).status, 403);
      assert.equal((await get(url.replace(a.fieldId, b.fieldId))).status, 404);
      assert.equal((await get(url + '?from=2026-02-30')).status, 422);
    }

    const empty = await get(base + '?from=2026-10-16&to=2026-10-16');
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).data.counts, { observations: 0, workOrders: 0 });
    assert.equal((await get(base + '?from=2026-02-30')).status, 422);
    assert.equal((await get(base + '?from=2026-10-16&to=2026-10-15')).status, 422);
    assert.equal((await get(base + '?evil=1')).status, 422);
    assert.equal((await get(base, restricted)).status, 403);
    assert.equal((await get(base.replace(a.fieldId, b.fieldId))).status, 404);

    await owner.query(`
      INSERT INTO scouting_observations
        (tenant_id,scouting_run_id,field_id,observed_by,observation_type,notes,observed_at)
      SELECT $1,$2,$3,$4,'general','bounded', '2026-10-15T12:00:00Z'
      FROM generate_series(1, 201)
    `, [tenantA, a.run, a.fieldId, coordinator]);
    const oversized = await get(base);
    assert.equal(oversized.status, 413);
    assert.match(oversized.headers.get('cache-control') || '', /no-store/);
  } finally {
    if (connected) {
      if (ids.tenants.length) await owner.query(
        'DELETE FROM tenants WHERE id = ANY($1::uuid[])', [ids.tenants]
      ).catch(() => {});
      if (ids.users.length) await owner.query(
        'DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]
      ).catch(() => {});
      await owner.end();
    }
  }
});
));
      const file = Buffer.from(doc.content_base64, 'base64');
      assert.equal(file.length, doc.size_bytes);
      assert.ok(file.length > 250 && file.length < 3 * 1024 * 1024);
      assert.equal(file.subarray(0, 4).toString('latin1'),
        format === 'pdf' ? '%PDF' : 'PK\\x03\\x04');
      const text = file.toString(format === 'pdf' ? 'latin1' : 'utf8');
      assert.ok(text.includes('HYPERLINK'));
      assert.ok(!text.includes('DO NOT LEAK BRAVO'));
      assert.ok(!text.includes('Bravo secret'));
      assert.equal((await get(url, restricted)).status, 403);
      assert.equal((await get(url.replace(a.fieldId, b.fieldId))).status, 404);
      assert.equal((await get(url + '?from=2026-02-30')).status, 422);
    }

    const empty = await get(base + '?from=2026-10-16&to=2026-10-16');
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).data.counts, { observations: 0, workOrders: 0 });
    assert.equal((await get(base + '?from=2026-02-30')).status, 422);
    assert.equal((await get(base + '?from=2026-10-16&to=2026-10-15')).status, 422);
    assert.equal((await get(base + '?evil=1')).status, 422);
    assert.equal((await get(base, restricted)).status, 403);
    assert.equal((await get(base.replace(a.fieldId, b.fieldId))).status, 404);

    await owner.query(`
      INSERT INTO scouting_observations
        (tenant_id,scouting_run_id,field_id,observed_by,observation_type,notes,observed_at)
      SELECT $1,$2,$3,$4,'general','bounded', '2026-10-15T12:00:00Z'
      FROM generate_series(1, 201)
    `, [tenantA, a.run, a.fieldId, coordinator]);
    const oversized = await get(base);
    assert.equal(oversized.status, 413);
    assert.match(oversized.headers.get('cache-control') || '', /no-store/);
  } finally {
    if (connected) {
      if (ids.tenants.length) await owner.query(
        'DELETE FROM tenants WHERE id = ANY($1::uuid[])', [ids.tenants]
      ).catch(() => {});
      if (ids.users.length) await owner.query(
        'DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]
      ).catch(() => {});
      await owner.end();
    }
  }
});
