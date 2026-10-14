import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Disposable *_test PostgreSQL URLs are required.');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'ci-sync-observation-only-not-production';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { Client } = pg;

test('offline observation batches apply exactly once, deny revoked resources and leave scoped audit', async (t) => {
  const owner = new Client({ connectionString: adminUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sequelize.close();
  });

  const root = `http://127.0.0.1:${server.address().port}/api/v1`;
  const stamp = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenantIds = [];
  const userIds = [];
  let connected = false;
  try {
    await owner.connect();
    connected = true;
    const { rows: [{ name }] } = await owner.query('SELECT current_database() AS name');
    assert.match(name, /(?:^|[_-])test(?:$|[_-])/i, 'Refusing live database fixtures');
    const { rows: [plan] } = await owner.query("SELECT id FROM plans WHERE code = 'starter'");
    const { rows: [crop] } = await owner.query("SELECT id FROM crop_types WHERE code = 'soy'");
    assert.ok(plan && crop);
    async function insert(sql, values) {
      return (await owner.query(sql, values)).rows[0].id;
    }
    const a = await insert(
      "INSERT INTO tenants (plan_id,name,slug,status) VALUES ($1,'Sync A',$2,'active') RETURNING id",
      [plan.id, `sync-a-${stamp}`]
    );
    tenantIds.push(a);
    const b = await insert(
      "INSERT INTO tenants (plan_id,name,slug,status) VALUES ($1,'Sync B',$2,'active') RETURNING id",
      [plan.id, `sync-b-${stamp}`]
    );
    tenantIds.push(b);
    const admin = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ('Admin',$1,'fixture') RETURNING id",
      [`sync-admin-${stamp}@example.test`]
    );
    userIds.push(admin);
    const scout = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ('Scout',$1,'fixture') RETURNING id",
      [`sync-scout-${stamp}@example.test`]
    );
    userIds.push(scout);
    const other = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ('Other scout',$1,'fixture') RETURNING id",
      [`sync-other-${stamp}@example.test`]
    );
    userIds.push(other);
    await owner.query(
      "INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES ($1,$2,'tenant_admin','active'),($1,$3,'scout','active'),($1,$4,'scout','active')",
      [a, admin, scout, other]
    );
    await owner.query(
      "INSERT INTO tenant_modules (tenant_id,module_code,is_enabled,source) VALUES ($1,'scouting',true,'plan'),($2,'scouting',true,'plan')",
      [a, b]
    );
    const farmA = await insert("INSERT INTO farms (tenant_id,name) VALUES ($1,'Sync Farm A') RETURNING id", [a]);
    const fieldA = await insert("INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,'Sync Field A') RETURNING id", [a,farmA]);
    const farmB = await insert("INSERT INTO farms (tenant_id,name) VALUES ($1,'Sync Farm B') RETURNING id", [b]);
    const fieldB = await insert("INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,'Sync Field B') RETURNING id", [b,farmB]);
    const campaignA = await insert(
      "INSERT INTO campaigns (tenant_id,name,season_year,starts_at) VALUES ($1,'Sync Campaign A',2026,'2026-01-01') RETURNING id", [a]
    );
    const campaignB = await insert(
      "INSERT INTO campaigns (tenant_id,name,season_year,starts_at) VALUES ($1,'Sync Campaign B',2026,'2026-01-01') RETURNING id", [b]
    );
    const cfA = await insert(
      "INSERT INTO campaign_fields (tenant_id,campaign_id,field_id,crop_type_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [a,campaignA,fieldA,crop.id]
    );
    const cfB = await insert(
      "INSERT INTO campaign_fields (tenant_id,campaign_id,field_id,crop_type_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [b,campaignB,fieldB,crop.id]
    );
    const run = await insert(
      "INSERT INTO scouting_runs (tenant_id,campaign_field_id,assigned_to,status) VALUES ($1,$2,$3,'in_progress') RETURNING id",
      [a, cfA, scout]
    );
    const otherRun = await insert(
      "INSERT INTO scouting_runs (tenant_id,campaign_field_id,assigned_to,status) VALUES ($1,$2,$3,'in_progress') RETURNING id",
      [a, cfA, other]
    );
    const foreignRun = await insert(
      "INSERT INTO scouting_runs (tenant_id,campaign_field_id,status) VALUES ($1,$2,'in_progress') RETURNING id",
      [b, cfB]
    );

    const tokens = {
      admin: signSession({ sub: admin, role_code: 'tenant_admin', tenant_id: a }),
      scout: signSession({ sub: scout, role_code: 'scout', tenant_id: a }),
      other: signSession({ sub: other, role_code: 'scout', tenant_id: a })
    };
    async function request(path, who = 'scout', method = 'GET', body, tenantId = a) {
      const response = await fetch(root + path, {
        method, headers: {
          authorization: `Bearer ${tokens[who]}`,
          'x-tenant-id': tenantId,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, json: await response.json() };
    }
    const gpsPoint = { type: 'Point', coordinates: [-57.9521, -34.9205] };
    const operation = (runId = run, opId = randomUUID(), point = null) => ({
      entity_type: 'scouting_observation',
      entity_client_id: opId,
      operation: 'create',
      payload: {
        scouting_run_id: runId,
        observation_type: 'pest',
        severity: 'high',
        ...(point ? { point } : {}),
        notes: 'Sensitive raw scouting notes must not be copied into audit'
      }
    });
    const key = randomUUID();
    const body = {
      idempotency_key: key,
      client_id: 'offline-mobile-client',
      device_id: 'test-device',
      operations: [operation(run, randomUUID(), gpsPoint)]
    };
    const created = await request('/sync/batches', 'scout', 'POST', body);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.data.status, 'processed');
    assert.equal(created.json.data.operations.length, 1);
    assert.equal(created.json.data.operations[0].status, 'applied');
    const obsId = created.json.data.operations[0].result.observation_id;
    assert.ok(obsId);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM scouting_observations WHERE id = $1', [obsId])).rows[0].n, 1);
    const gps = (await owner.query(
      'SELECT ST_X(point) AS longitude, ST_Y(point) AS latitude FROM scouting_observations WHERE id = $1',
      [obsId]
    )).rows[0];
    assert.deepEqual(gps, { longitude: gpsPoint.coordinates[0], latitude: gpsPoint.coordinates[1] },
      'PostGIS must persist the opt-in WGS84 position, longitude before latitude');

    const duplicate = await request('/sync/batches', 'scout', 'POST', body);
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
    assert.equal(duplicate.json.replayed, true);
    assert.equal(duplicate.json.data.id, created.json.data.id);
    assert.equal(duplicate.json.data.operations[0].result.observation_id, obsId);
    const changedKeyReuse = { ...body, operations: [operation()] };
    assert.equal((await request('/sync/batches', 'scout', 'POST', changedKeyReuse)).status, 409);
    assert.equal((await request('/sync/batches', 'other', 'POST', {
      ...body, idempotency_key: randomUUID(), operations: [operation(run)]
    })).status, 404);
    assert.equal((await request('/sync/batches', 'scout', 'POST', {
      ...body, idempotency_key: randomUUID(), operations: [operation(foreignRun)]
    })).status, 404);

    const untrusted = { ...body, idempotency_key: randomUUID(), operations: [
      { ...operation(), entity_type: 'work_order' }
    ] };
    assert.equal((await request('/sync/batches', 'scout', 'POST', untrusted)).status, 422);
    assert.equal((await request('/sync/batches', 'scout', 'POST', {
      ...body, idempotency_key: randomUUID(), operations: [
        { ...operation(), payload: { ...operation().payload, field_id: fieldB } }
      ]
    })).status, 422);
    assert.equal((await request('/sync/batches', 'scout', 'POST', {
      ...body, idempotency_key: randomUUID(), operations: [
        operation(run), operation(otherRun)
      ]
    })).status, 404, 'mixed permitted/forbidden operations must rollback atomically');

    const own = await request('/sync/my-batches');
    assert.equal(own.status, 200);
    assert.deepEqual(own.json.data.map((x) => x.id), [created.json.data.id]);
    assert.equal((await request('/sync/batches', 'scout')).status, 403);
    const adminReceipts = await request('/sync/batches', 'admin');
    assert.equal(adminReceipts.status, 200);
    assert.equal(adminReceipts.json.data.length, 1);
    assert.equal((await request('/sync/my-batches', 'scout', 'GET', undefined, b)).status, 403);

    const audits = await request(`/scouting/runs/${run}/audit`, 'admin');
    assert.equal(audits.status, 200, JSON.stringify(audits.json));
    assert.equal(audits.json.data.length, 1);
    assert.equal(audits.json.data[0].actor_id, scout);
    assert.equal(audits.json.data[0].action, 'scouting.observation.synced');
    assert.ok(!JSON.stringify(audits.json.data).includes('Sensitive raw scouting notes'));
    assert.equal((await request(`/scouting/runs/${run}/audit`)).status, 403);

    // Two simultaneous mobile retries with the same key must produce one
    // observation, even if requests reach separate transaction connections.
    const concurrentBody = {
      ...body,
      idempotency_key: randomUUID(),
      operations: [operation()]
    };
    const simultaneous = await Promise.all([
      request('/sync/batches', 'scout', 'POST', concurrentBody),
      request('/sync/batches', 'scout', 'POST', concurrentBody)
    ]);
    assert.deepEqual(simultaneous.map((item) => item.status).sort(), [200, 201],
      JSON.stringify(simultaneous));
    assert.equal(simultaneous[0].json.data.id, simultaneous[1].json.data.id);
    assert.equal(simultaneous[0].json.data.operations[0].result.observation_id,
      simultaneous[1].json.data.operations[0].result.observation_id);

    await owner.query("UPDATE scouting_runs SET status = 'completed' WHERE id = $1", [run]);
    assert.equal((await request('/sync/batches', 'scout', 'POST', {
      ...body, idempotency_key: randomUUID(), operations: [operation()]
    })).status, 409);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM scouting_observations WHERE scouting_run_id = $1', [run]
    )).rows[0].n, 2, 'two accepted unique batches create exactly two observations');
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM sync_batches WHERE tenant_id = $1', [a]
    )).rows[0].n, 2, 'failed atomic batches must leave no received/queued records');
  } finally {
    if (connected) {
      try {
        if (tenantIds.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
        if (userIds.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      } finally {
        await owner.end();
      }
    }
  }
});
