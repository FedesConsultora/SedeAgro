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
      "INSERT INTO tenant_modules (tenant_id,module_code,is_enabled,source) VALUES ($1,'scouting',true,'plan'),($2,'scouting',true,'plan'),($1,'gis',true,'plan'),($1,'campaigns',true,'plan')",
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
    const campaignFieldB = await insert(
      "INSERT INTO campaign_fields (tenant_id,campaign_id,field_id,crop_type_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [tenantA, campaign, fieldA2, crop.id]
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
    const assigneeOptions = await request('/assignees', adminToken);
    assert.equal(assigneeOptions.status, 200);
    assert.deepEqual(new Set(assigneeOptions.json.data.map((member) => member.id)),
      new Set([scoutId, otherScoutId]));
    assert.equal((await request('/assignees', scoutToken)).status, 403);
    assert.equal((await request('/runs', adminToken, 'POST', {
      campaign_field_id: campaignField,
      assigned_to: adminId,
      status: 'planned'
    })).status, 422);

    const unassignedRun = await request('/runs', adminToken, 'POST', {
      campaign_field_id: campaignField,
      status: 'planned'
    });
    assert.equal(unassignedRun.status, 201);
    assert.equal((await request(`/runs/${unassignedRun.json.data.id}`, adminToken, 'PATCH',
      { status: 'in_progress' })).status, 409);

    const newRun = await request('/runs', adminToken, 'POST', {
      campaign_field_id: campaignField, assigned_to: scoutId, status: 'in_progress'
    });
    assert.equal(newRun.status, 201, JSON.stringify(newRun.json));
    const runId = newRun.json.data.id;

    const otherRun = await request('/runs', adminToken, 'POST', {
      campaign_field_id: campaignFieldB, assigned_to: otherScoutId
    });
    assert.equal(otherRun.status, 201);

    const mine = await request('/runs');
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json.data.map(r => r.id), [runId]);
    assert.equal((await request(`/runs/${otherRun.json.data.id}`)).status, 404);
    assert.equal((await request(`/runs/${runId}`, otherToken)).status, 404);

    assert.equal((await request(`/runs/${runId}`, adminToken, 'PATCH', {
      assigned_to: otherScoutId
    })).status, 409, 'running assignments cannot be changed');

    async function scopedRequest(path, token = scoutToken, method = 'GET', body = undefined) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-tenant-id': tenantA,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, json: await response.json() };
    }
    const myFields = await scopedRequest('/fields');
    assert.equal(myFields.status, 200, JSON.stringify(myFields.json));
    assert.deepEqual(myFields.json.data.map((item) => item.id), [fieldA]);
    assert.deepEqual((await scopedRequest('/fields', otherToken)).json.data.map((item) => item.id), [fieldA2]);
    assert.equal((await scopedRequest(`/fields/${fieldA2}`)).status, 404);
    assert.equal((await scopedRequest(`/farms/${extraFarmA}`)).status, 404);
    const myFarms = await scopedRequest('/farms');
    assert.equal(myFarms.status, 200);
    assert.deepEqual(myFarms.json.data.map((item) => item.id), [farmA]);
    assert.deepEqual(myFarms.json.data[0].Fields.map((item) => item.id), [fieldA]);
    const campaignFieldsForScout = await scopedRequest('/campaigns/fields');
    assert.equal(campaignFieldsForScout.status, 200);
    assert.deepEqual(campaignFieldsForScout.json.data.map((item) => item.id), [campaignField]);
    const campaignDetail = await scopedRequest(`/campaigns/${campaign}`);
    assert.equal(campaignDetail.status, 200);
    assert.deepEqual(campaignDetail.json.data.CampaignFields.map((item) => item.field_id), [fieldA]);
    const campaigns = await scopedRequest('/campaigns');
    assert.equal(campaigns.status, 200);
    assert.deepEqual(campaigns.json.data[0].CampaignFields.map((item) => item.field_id), [fieldA]);

    assert.equal((await scopedRequest(`/fields/${fieldA2}/rainfall`, scoutToken, 'POST', {
      amount_mm: 14, measured_at: new Date().toISOString()
    })).status, 404);
    assert.equal((await scopedRequest(`/fields/${fieldA2}/irrigation`, scoutToken, 'POST', {
      amount_mm: 14, started_at: new Date().toISOString()
    })).status, 404);
    assert.equal((await scopedRequest(`/fields/${fieldA}/rainfall`, scoutToken, 'POST', {
      amount_mm: 14, measured_at: new Date().toISOString()
    })).status, 201);


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

    const offlineUploadId = randomUUID();
    const offlineBody = {
      ...evidenceBody,
      client_upload_id: offlineUploadId,
      original_name: 'offline-photo.png'
    };
    const offlineFirst = await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', offlineBody);
    assert.equal(offlineFirst.status, 201, JSON.stringify(offlineFirst.json));
    assert.equal(offlineFirst.json.data.client_upload_id, offlineUploadId);
    const offlineReplay = await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', offlineBody);
    assert.equal(offlineReplay.status, 200, JSON.stringify(offlineReplay.json));
    assert.equal(offlineReplay.json.replayed, true);
    assert.equal(offlineReplay.json.data.id, offlineFirst.json.data.id);
    assert.equal((await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', {
      ...offlineBody, original_name: 'changed-name.png'
    })).status, 409, 'same upload UUID cannot silently attach another file');
    assert.equal((await request(`/observations/${observationId}/evidence`, otherToken, 'POST', offlineBody)).status, 404);
    assert.equal((await request(`/observations/${observationId}/evidence`, scoutToken, 'POST',
      offlineBody, tenantB)).status, 403);

    const detail = await request(`/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.ScoutingObservations.length, 1);
    assert.equal(detail.json.data.ScoutingObservations[0].EvidenceAssets.length, 2);
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

    // 0S.12: verify that metadata presence and actual private byte storage
    // are distinct; no bytes, SHA or file names escape this read-only API.
    const trace = await request(`/runs/${runId}/evidence-status`);
    assert.equal(trace.status, 200, JSON.stringify(trace.json));
    assert.equal(trace.headers.get('cache-control'), 'private, no-store');
    assert.equal(trace.json.data.run_id, runId);
    assert.equal(trace.json.data.limit, 100);
    assert.equal(trace.json.data.has_more, false);
    assert.equal(trace.json.data.items.length, 2);
    const offlineTrace = trace.json.data.items.find(item => item.client_upload_id === offlineUploadId);
    assert.equal(offlineTrace.id, offlineFirst.json.data.id);
    assert.equal(offlineTrace.uploaded_by, scoutId);
    assert.equal(offlineTrace.scouting_observation_id, observationId);
    assert.equal(offlineTrace.bytes_available, true);
    assert.ok(trace.json.data.items.every(item => item.bytes_available));
    for (const privateField of ['content', 'content_base64', 'storage_key',
      'original_name', 'content_sha256']) {
      assert.ok(!JSON.stringify(trace.json).includes(`"${privateField}"`));
    }
    assert.equal((await request(`/runs/${runId}/evidence-status`, otherToken)).status, 404,
      'scout without assignment cannot inspect evidence presence');
    assert.equal((await request(`/runs/${runId}/evidence-status`, scoutToken,
      'GET', undefined, tenantB)).status, 403,
      'another tenant cannot inspect evidence');
    assert.equal((await request(`/runs/${randomUUID()}/evidence-status`, scoutToken)).status, 404);
    const replayTrace = await request(`/runs/${runId}/evidence-status`);
    assert.equal(replayTrace.json.data.items.filter(item =>
      item.client_upload_id === offlineUploadId).length, 1,
    'idempotent replay must not create duplicate provenance rows');

    // Disposable DB only: simulate a historical metadata-only asset, then
    // restore bytes so remaining scouting acceptance continues unchanged.
    await owner.query('DELETE FROM evidence_blobs WHERE evidence_id = $1', [evidenceId]);
    const missingBlob = await request(`/runs/${runId}/evidence-status`);
    assert.equal(missingBlob.status, 200);
    assert.equal(missingBlob.json.data.items.find(item => item.id === evidenceId).bytes_available, false);
    assert.equal(missingBlob.json.data.items.find(item =>
      item.client_upload_id === offlineUploadId).bytes_available, true);
    await owner.query(
      'INSERT INTO evidence_blobs (evidence_id, tenant_id, content) VALUES ($1,$2,$3)',
      [evidenceId, tenantA, png]
    );

    const completed = await request(`/runs/${runId}`, adminToken, 'PATCH', { status: 'completed' });
    assert.equal(completed.status, 200, JSON.stringify(completed.json));
    assert.ok(completed.json.data.completed_at);
    const replayAfterClose = await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', offlineBody);
    assert.equal(replayAfterClose.status, 200);
    assert.equal(replayAfterClose.json.data.id, offlineFirst.json.data.id,
      'lost upload response must be replayable after run completion');
    assert.equal((await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', {
      ...offlineBody, client_upload_id: randomUUID()
    })).status, 409, 'a closed run must reject genuinely new uploads');

    assert.equal((await request(`/runs/${runId}/observations`, scoutToken, 'POST', {
      observation_type: 'weed', notes: 'After closure'
    })).status, 409);
    assert.equal((await request(`/observations/${observationId}/evidence`, scoutToken, 'POST', evidenceBody)).status, 409);
    assert.equal((await request(`/runs/${runId}`, adminToken, 'PATCH', { status: 'in_progress' })).status, 409);
    const reassigned = await request(`/runs/${otherRun.json.data.id}`, adminToken, 'PATCH',
      { assigned_to: scoutId });
    assert.equal(reassigned.status, 200);
    assert.equal((await request(`/runs/${otherRun.json.data.id}`, otherToken)).status, 404);
    assert.equal((await request(`/runs/${otherRun.json.data.id}`, scoutToken)).status, 200);
    assert.deepEqual((await scopedRequest('/fields', otherToken)).json.data, []);
    assert.deepEqual(new Set((await scopedRequest('/fields')).json.data.map((item) => item.id)),
      new Set([fieldA, fieldA2]));

    assert.equal((await scopedRequest(`/campaigns/${campaign}`, otherToken)).status, 404);
    assert.equal((await request(`/runs/${otherRun.json.data.id}/status`, otherToken, 'PATCH',
      { status: 'in_progress' })).status, 404);
    assert.equal((await request(`/runs/${otherRun.json.data.id}/status`, scoutToken, 'PATCH',
      { status: 'completed' })).status, 409, 'scout cannot skip start');
    const startedByScout = await request(`/runs/${otherRun.json.data.id}/status`, scoutToken, 'PATCH',
      { status: 'in_progress' });
    assert.equal(startedByScout.status, 200, JSON.stringify(startedByScout.json));
    const finishedByScout = await request(`/runs/${otherRun.json.data.id}/status`, scoutToken, 'PATCH',
      { status: 'completed' });
    assert.equal(finishedByScout.status, 200, JSON.stringify(finishedByScout.json));
    assert.ok(finishedByScout.json.data.completed_at);
    assert.equal((await request(`/runs/${otherRun.json.data.id}/status`, scoutToken, 'PATCH',
      { status: 'in_progress' })).status, 409);

  } finally {
    if (connected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      } finally { await owner.end(); }
    }
  }
});
