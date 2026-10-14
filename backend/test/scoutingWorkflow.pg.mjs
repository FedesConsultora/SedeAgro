// End-to-end field scouting and binary evidence gate on disposable PostGIS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('A disposable *_test PostgreSQL database is required.');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'scouting-ci-only-secret';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { Client } = pg;

test('real scouting: assigned reads, derived field, evidence upload/download, closed runs and RLS', async (t) => {
  const owner = new Client({ connectionString: adminUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/scouting`;
  let connected = false;
  const tenants = [];
  const users = [];
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

  try {
    await owner.connect();
    connected = true;
    const { rows: [{ name }] } = await owner.query('SELECT current_database() AS name');
    assert.match(name, /(?:^|[_-])test(?:$|[_-])/i);
    const [[plan], [crop]] = await Promise.all([
      owner.query("SELECT id FROM plans WHERE code = 'starter'").then(q => q.rows),
      owner.query("SELECT id FROM crop_types WHERE code = 'soy'").then(q => q.rows)
    ]);
    assert.ok(plan && crop, 'Global seeds required');

    async function insert(sql, args) {
      return (await owner.query(sql, args)).rows[0].id;
    }
    const tenantA = await insert(
      "INSERT INTO tenants (name, slug, status, plan_id) VALUES ($1,$2,'active',$3) RETURNING id",
      ['Scouting A', `scouting-a-${suffix}`, plan.id]
    );
    tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants (name, slug, status, plan_id) VALUES ($1,$2,'active',$3) RETURNING id",
      ['Scouting B', `scouting-b-${suffix}`, plan.id]
    );
    tenants.push(tenantB);

    const adminId = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ('Admin', $1, 'fixture') RETURNING id",
      [`scouting-admin-${suffix}@example.test`]
    );
    users.push(adminId);
    const scoutId = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ('Scout', $1, 'fixture') RETURNING id",
      [`scouting-worker-${suffix}@example.test`]
    );
    users.push(scoutId);
    const otherScoutId = await insert(
      "INSERT INTO users (full_name,email,password_hash) VALUES ('Other scout', $1, 'fixture') RETURNING id",
      [`scouting-other-${suffix}@example.test`]
    );
    users.push(otherScoutId);
    await owner.query(
      "INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES ($1,$2,'tenant_admin','active'),($1,$3,'scout','active'),($1,$4,'scout','active')",
      [tenantA, adminId, scoutId, otherScoutId]
    );
    await owner.query(
      "INSERT INTO tenant_modules (tenant_id,module_code,is_enabled,source) VALUES ($1,'scouting',true,'plan'),($2,'scouting',true,'plan')",
      [tenantA, tenantB]
    );
    const farmA = await insert("INSERT INTO farms (tenant_id,name) VALUES ($1,$2) RETURNING id",
      [tenantA, `Scouting Farm A ${suffix}`]);
    const farmB = await insert("INSERT INTO farms (tenant_id,name) VALUES ($1,$2) RETURNING id",
      [tenantB, `Scouting Farm B ${suffix}`]);
    const fieldA = await insert("INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id",
      [tenantA, farmA, `Scouting Field A ${suffix}`]);
    const extraFarmA = await insert("INSERT INTO farms (tenant_id,name) VALUES ($1,$2) RETURNING id",
      [tenantA, `Scouting Farm A2 ${suffix}`]);
    const fieldA2 = await insert("INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id",
      [tenantA, extraFarmA, `Scouting Field A2 ${suffix}`]);
    await insert("INSERT INTO fields (tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id",
      [tenantB, farmB, `Scouting Field B ${suffix}`]);
    const campaign = await insert(
      "INSERT INTO campaigns (tenant_id,name,season_year,starts_at) VALUES ($1,$2,2026,'2026-01-01') RETURNING id",
      [tenantA, `Scouting Campaign ${suffix}`]
    );
    const campaignField = await insert(
      "INSERT INTO campaign_fields (tenant_id,campaign_id,field_id,crop_type_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [tenantA, campaign, fieldA, crop.id]
    );
    const adminToken = signSession({ sub: adminId, role_code: 'tenant_admin', tenant_id: tenantA });
    const scoutToken = signSession({ sub: scoutId, role_code: 'scout', tenant_id: tenantA });
    const otherToken = signSession({ sub: otherScoutId, role_code: 'scout', tenant_id: tenantA });

    async function request(path, token = scoutToken, method = 'GET', body = undefined, tenant = tenantA) {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-tenant-id': tenant,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const json = await response.json();
      return { status: response.status, json };
    }
    const newRun = await request('/runs', adminToken, 'POST', {
      campaign_field_id: campaignField, assigned_to: scoutId, status: 'in_progress'
    });
    assert.equal(newRun.status, 201, JSON.stringify(newRun.json));
    const runId = newRun.json.data.id;

    const otherRun = await request('/runs', adminToken, 'POST', {
      campaign_field_id: campaignField, assigned_to: otherScoutId
    });
    assert.equal(otherRun.status, 201);

    const mine = await request('/runs');
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json.data.map(r => r.id), [runId]);
    assert.equal((await request(`/runs/${otherRun.json.data.id}`)).status, 404);
    assert.equal((await request(`/runs/${runId}`, otherToken)).status, 404);

    const wrongField = await request(`/runs/${runId}/observations`, scoutToken, 'POST', {
      field_id: fieldA2, observation_type: 'pest', severity: 'high', notes: 'Test mismatch'
    });
    assert.equal(wrongField.status, 422, JSON.stringify(wrongField.json));

    const created = await request(`/runs/${runId}/observations`, scoutToken, 'POST', {
      observation_type: 'pest', severity: 'high', notes: 'Insects in the northern sector'
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.data.field_id, fieldA);
    const observationId = created.json.data.id;
    assert.equal((await request(`/runs/${otherRun.json.data.id}/observations`, scoutToken, 'POST', {
      observation_type: 'weed', notes: 'Should be rejected'
    })).status, 404);

    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const evidenceBody = {
      kind: 'photo', mime_type: 'image/png',
      original_name: 'field-scout-test.png', content_base64: png.toString('base64')
    };
    assert.equal((await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', {
      kind: 'photo', mime_type: 'image/png', original_name: 'fake.png', storage_key: 'external/not-uploaded'
    })).status, 422);
    assert.equal((await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', {
      ...evidenceBody, content_base64: Buffer.from('not an image').toString('base64')
    })).status, 422);
    const added = await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', evidenceBody);
    assert.equal(added.status, 201, JSON.stringify(added.json));
    const evidenceId = added.json.data.id;
    assert.equal(added.json.data.size_bytes, png.length);

    const detail = await request(`/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.ScoutingObservations.length, 1);
    assert.equal(detail.json.data.ScoutingObservations[0].EvidenceAssets.length, 1);
    const downloaded = await request(`/evidence/${evidenceId}/content`);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(downloaded.json.data.content_base64, 'base64'), png);
    assert.equal((await request(`/evidence/${evidenceId}/content`, otherToken)).status, 404);
    assert.equal((await request(`/evidence/${evidenceId}/content`, scoutToken, 'GET', undefined, tenantB)).status, 403);
    const { rows: [blob] } = await owner.query(
      'SELECT content, tenant_id FROM evidence_blobs WHERE evidence_id = $1', [evidenceId]
    );
    assert.equal(blob.tenant_id, tenantA);
    assert.deepEqual(blob.content, png);

    const completed = await request(`/runs/${runId}`, adminToken, 'PATCH', { status: 'completed' });
    assert.equal(completed.status, 200, JSON.stringify(completed.json));
    assert.ok(completed.json.data.completed_at);
    assert.equal((await request(`/runs/${runId}/observations`, scoutToken, 'POST', {
      observation_type: 'weed', notes: 'After closure'
    })).status, 409);
    assert.equal((await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', evidenceBody)).status, 409);
    assert.equal((await request(`/runs/${runId}`, adminToken, 'PATCH', { status: 'in_progress' })).status, 409);
  } finally {
    if (connected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      } finally { await owner.end(); }
    }
  }
});
