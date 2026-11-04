// Pilot 0.1: one coherent crop workflow against REAL Express + disposable PostGIS.
// Complements per-module tests; never exercises a real/staging/production DB.
// This does not certify browser IndexedDB, field devices or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) {
  throw new Error('Pilot path requires disposable *_test owner AND runtime database URLs.');
}
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'only-disposable-pilot-path-test-secret';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { Client } = pg;

test('0U pilot: one tenant crop -> offline observation+GPS -> private JPEG -> reviewed order -> real exports', async t => {
  const owner = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [];
  const users = [];
  let ownerConnected = false;
  let runtimeConnected = false;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });

  async function insert(sql, args) {
    return (await owner.query(sql, args)).rows[0].id;
  }
  try {
    await owner.connect();
    ownerConnected = true;
    await runtime.connect();
    runtimeConnected = true;
    const [ownerDb, appRole] = await Promise.all([
      owner.query('SELECT current_database() AS db'),
      runtime.query(`SELECT current_database() AS db, current_user AS db_role,
        rolsuper, rolbypassrls, pg_get_userbyid(datdba) AS db_owner
        FROM pg_roles JOIN pg_database ON datname=current_database()
        WHERE rolname=current_user`)
    ]);
    assert.match(ownerDb.rows[0].db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(appRole.rows[0].db, ownerDb.rows[0].db);
    assert.equal(appRole.rows[0].rolsuper, false);
    assert.equal(appRole.rows[0].rolbypassrls, false);
    assert.notEqual(appRole.rows[0].db_role, appRole.rows[0].db_owner);

    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const crop = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    assert.ok(plan && crop, 'CI seed data is required');
    const tenantA = await insert(
      "INSERT INTO tenants(name,slug,plan_id,status) VALUES($1,$2,$3,'active') RETURNING id",
      ['Pilot A', `pilot-a-${suffix}`, plan.id]);
    tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(name,slug,plan_id,status) VALUES($1,$2,$3,'active') RETURNING id",
      ['Pilot B', `pilot-b-${suffix}`, plan.id]);
    tenants.push(tenantB);

    async function user(name, tenant, role) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [name, `pilot-${suffix}-${name.replaceAll(' ','-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenant, id, role]);
      return { id, token: signSession({ sub: id, tenant_id: tenant, role_code: role }), tenant };
    }
    const admin = await user('admin', tenantA, 'tenant_admin');
    const scout = await user('scout', tenantA, 'scout');
    const contractor = await user('contractor', tenantA, 'contractor');
    const foreignAdmin = await user('foreign admin', tenantB, 'tenant_admin');
    for (const tenant of [tenantA, tenantB]) {
      await owner.query(`INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source)
        VALUES ($1,'gis',true,'plan'), ($1,'campaigns',true,'plan'),
          ($1,'scouting',true,'plan'), ($1,'work_orders',true,'plan'),
          ($1,'reports',true,'plan')`, [tenant]);
    }

    const farm = await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantA, 'Pilot Farm']);
    const field = await insert(
      'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
      [tenantA, farm, 'North Lot']);
    const campaign = await insert(
      "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-01-01') RETURNING id",
      [tenantA, '2026 Pilot']);
    const campaignField = await insert(`INSERT INTO campaign_fields
      (tenant_id,campaign_id,field_id,crop_type_id) VALUES($1,$2,$3,$4) RETURNING id`,
      [tenantA, campaign, field, crop.id]);

    async function request(path, actor = admin, method = 'GET', body) {
      const response = await fetch(origin + path, {
        method,
        headers: { authorization: `Bearer ${actor.token}`, 'x-tenant-id': actor.tenant,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, data: await response.json(), headers: response.headers };
    }
    const expectStatus = async (path, actor, method, body, status) => {
      const response = await request(path, actor, method, body);
      assert.equal(response.status, status,
        `${method} ${path}: ${JSON.stringify(response.data)}`);
      return response.data;
    };

    // Same real campaign and field must survive every domain boundary.
    const run = (await expectStatus('/scouting/runs', admin, 'POST', {
      campaign_field_id: campaignField, assigned_to: scout.id, status: 'in_progress'
    }, 201)).data.id;
    assert.equal((await expectStatus(`/scouting/runs/${run}`, scout, 'GET', undefined, 200))
      .data.campaign_field_id, campaignField);
    await expectStatus(`/scouting/runs/${run}`, foreignAdmin, 'GET', undefined, 404);

    const key = randomUUID();
    const operation = randomUUID();
    const gps = { type: 'Point', coordinates: [-57.9521, -34.9205] };
    const observationPayload = {
      client_id: 'sedeagro-web-offline-v1',
      idempotency_key: key,
      operations: [{ entity_type: 'scouting_observation', entity_client_id: operation,
        operation: 'create', payload: { scouting_run_id: run, observation_type: 'pest',
          severity: 'high', notes: 'Pilot observation created once',
          observed_at: new Date().toISOString(), point: gps } }]
    };
    const applied = await expectStatus('/sync/batches', scout, 'POST', observationPayload, 201);
    const observationId = applied.data.operations[0].result.observation_id;
    assert.ok(observationId);
    const replay = await expectStatus('/sync/batches', scout, 'POST', observationPayload, 200);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.operations[0].result.observation_id, observationId);
    await expectStatus('/sync/batches', contractor, 'POST', observationPayload, 403);

    // Backend validates actual MIME bytes and preserves the upload replay ID.
    const photo = Buffer.from('ffd8ffdb0000000000', 'hex');
    const evidencePayload = { kind: 'photo', mime_type: 'image/jpeg',
      original_name: 'lote-piloto.jpg', content_base64: photo.toString('base64'),
      client_upload_id: randomUUID() };
    const evidence = await expectStatus(`/scouting/observations/${observationId}/evidence`,
      scout, 'POST', evidencePayload, 201);
    const evidenceId = evidence.data.id;
    const evidenceReplay = await expectStatus(`/scouting/observations/${observationId}/evidence`,
      scout, 'POST', evidencePayload, 200);
    assert.equal(evidenceReplay.data.id, evidenceId);
    await expectStatus(`/scouting/evidence/${evidenceId}/content`,
      foreignAdmin, 'GET', undefined, 404);
    const privatePhoto = await expectStatus(`/scouting/evidence/${evidenceId}/content`,
      scout, 'GET', undefined, 200);
    assert.equal(privatePhoto.data.content_base64, evidencePayload.content_base64);

    // One real observation → one immutable, transactionally persisted order
    // origin. No GPS, notes or photo bytes cross the order API boundary.
    const orderRequestId = randomUUID();
    const orderRequest = {
      client_request_id: orderRequestId,
      field_id: field, campaign_field_id: campaignField,
      origin_observation_id: observationId,
      type: 'inspection', title: 'Review the same observed lot'
    };
    const firstOrder = await expectStatus('/work-orders', admin, 'POST', orderRequest, 201);
    assert.equal(firstOrder.replayed, false);
    assert.deepEqual(firstOrder.data.observation_origin, {
      scouting_observation_id: observationId, scouting_run_id: run
    });
    const order = firstOrder.data.id;
    const sameOrder = await expectStatus('/work-orders', admin, 'POST', orderRequest, 200);
    assert.equal(sameOrder.replayed, true);
    assert.equal(sameOrder.data.id, order);
    assert.deepEqual(sameOrder.data.observation_origin, firstOrder.data.observation_origin);
    const authoritativeDetail = await expectStatus(`/work-orders/${order}`,
      admin, 'GET', undefined, 200);
    assert.deepEqual(authoritativeDetail.data.observation_origin,
      firstOrder.data.observation_origin);
    await expectStatus(`/work-orders/${order}`, foreignAdmin, 'GET', undefined, 404);
    await expectStatus(`/work-orders/${order}`, contractor, 'GET', undefined, 404);
    await expectStatus(`/work-orders/${order}/assignees`, admin, 'POST',
      { user_id: contractor.id, responsibility: 'executor' }, 201);
    for (const status of ['pending_approval', 'approved', 'assigned']) {
      await expectStatus(`/work-orders/${order}/status`, admin, 'PATCH', { status }, 200);
    }
    const assigned = await expectStatus(`/work-orders/${order}`, contractor, 'GET', undefined, 200);
    assert.equal(assigned.data.field_id, field);
    assert.equal(assigned.data.observation_origin, undefined,
      'contractor must not receive the scouting origin identifier');
    const approvedAt = Date.parse(assigned.data.approved_at);
    assert.ok(Number.isFinite(approvedAt));
    await expectStatus(`/work-orders/${order}/status`, contractor, 'PATCH',
      { status: 'in_progress' }, 200);
    await expectStatus(`/work-orders/${order}/status`, admin, 'PATCH',
      { status: 'completed' }, 409);
    const finished = approvedAt + 110;
    if (Date.now() <= finished) await new Promise(resolve => setTimeout(resolve, finished - Date.now() + 20));
    const execution = (await expectStatus(`/work-orders/${order}/executions`, contractor, 'POST', {
      started_at: new Date(approvedAt + 10).toISOString(),
      finished_at: new Date(finished).toISOString(),
      worked_area_hectares: 1.25,
      result_summary: 'Inspección completada sobre el lote de observación del piloto.'
    }, 201)).data.id;
    await expectStatus(`/work-orders/${order}/executions/${execution}/review`, contractor,
      'POST', { decision: 'verified' }, 403);
    await expectStatus(`/work-orders/${order}/executions/${execution}/review`, admin,
      'POST', { decision: 'verified', checklist: { time_checked: true, area_checked: true,
        result_checked: true, operation_checked: true, evidence_basis: 'no_files' } }, 200);
    const closed = await expectStatus(`/work-orders/${order}/status`, admin, 'PATCH',
      { status: 'completed' }, 200);
    assert.equal(closed.data.status, 'completed');

    // Reports must read persisted observations AND the order in the same lot.
    for (const format of ['csv', 'pdf', 'xlsx']) {
      const endpoint = `/reports/field/${field}/export.${format}`;
      const output = await expectStatus(endpoint, admin, 'GET', undefined, 200);
      assert.deepEqual(output.data.counts, { observations: 1, workOrders: 1, executions: 1 });
      assert.match(output.data.filename, new RegExp(`\\.${format}$`));
      if (format === 'csv') {
        assert.ok(output.data.csv.includes('Pilot observation created once'));
        assert.ok(output.data.csv.includes('Review the same observed lot'));
        assert.ok(output.data.csv.includes('observacion_origen_id'));
        assert.ok(output.data.csv.includes(observationId));
        assert.ok(output.data.csv.includes(run));
        assert.ok(output.data.csv.includes('orden_asociada_id'));
        assert.ok(output.data.csv.includes('hectareas_ejecutadas'));
        assert.ok(output.data.csv.includes('fecha_revision_utc'));
        assert.ok(output.data.csv.includes('"ejecucion"'));
        assert.ok(output.data.csv.includes('"verified"'));
        assert.ok(output.data.csv.includes('"1.25"'));
        assert.ok(output.data.csv.includes(execution));
        assert.ok(output.data.csv.includes(order));
        assert.ok(output.data.csv.includes('Inspección completada sobre el lote'));
      } else {
        const bytes = Buffer.from(output.data.content_base64, 'base64');
        assert.equal(bytes.length, output.data.size_bytes);
        assert.deepEqual([...bytes.subarray(0, 4)],
          format === 'pdf' ? [37, 80, 68, 70] : [80, 75, 3, 4]);
        assert.ok(bytes.includes(Buffer.from(observationId, 'utf8')),
          format + ' must include verified order-origin ID in the final export');
        assert.ok(bytes.includes(Buffer.from(run, 'utf8')),
          format + ' must include the originating scouting run ID');
        assert.ok(bytes.includes(Buffer.from(execution, 'utf8')),
          format + ' must include actual independently reviewed execution UUID');
        assert.ok(bytes.includes(Buffer.from('verified', 'utf8')),
          format + ' must include persisted independent review outcome');
        assert.ok(bytes.includes(Buffer.from('1.25', 'utf8')),
          format + ' must include declared worked area');
        assert.ok(bytes.includes(Buffer.from('Inspección completada', 'utf8')),
          format + ' must include the actual declared operation result');
      }
      await expectStatus(endpoint, scout, 'GET', undefined, 403);
      await expectStatus(endpoint, foreignAdmin, 'GET', undefined, 404);
    }

    // A dated export must include a work actually FINISHED in the period,
    // even if its parent order was created much earlier. Update only this
    // disposable fixture's creation timestamp; do not change execution truth.
    await owner.query(`
      UPDATE work_orders SET created_at='2025-01-01T00:00:00Z'
      WHERE tenant_id=$1 AND id=$2
    `, [tenantA,order]);
    const completionDay = new Date(finished).toISOString().slice(0,10);
    const dated = await expectStatus(
      `/reports/field/${field}/export.csv?from=${completionDay}&to=${completionDay}`,
      admin,'GET',undefined,200);
    assert.equal(dated.data.counts.workOrders,0,
      'no historical parent order should be misdated as created this period');
    assert.equal(dated.data.counts.executions,1,
      'actual execution finished during the period must remain exported');
    assert.ok(dated.data.csv.includes(execution));
    assert.ok(dated.data.csv.includes(order));
    await expectStatus(
      `/reports/field/${field}/export.csv?from=${completionDay}&to=${completionDay}`,
      foreignAdmin,'GET',undefined,404);

    // Database evidence: exactly ONE observation, one private file, one
    // verified execution and the same lot for both products.
    const count = async (sql, args) => (await owner.query(sql, args)).rows[0];
    assert.equal((await count('SELECT count(*)::int AS n FROM scouting_observations WHERE id=$1',
      [observationId])).n, 1);
    assert.equal((await count('SELECT count(*)::int AS n FROM evidence_assets WHERE id=$1',
      [evidenceId])).n, 1);
    const linked = await count(`SELECT o.field_id AS order_field, s.field_id AS observed_field,
      e.review_status, v.scouting_run_id AS linked_run, v.campaign_field_id AS linked_campaign
      FROM work_order_observation_origins v
      JOIN work_orders o ON o.tenant_id=v.tenant_id AND o.id=v.work_order_id
      JOIN scouting_observations s ON s.tenant_id=v.tenant_id AND s.id=v.scouting_observation_id
      JOIN work_order_executions e ON e.work_order_id=o.id
      WHERE o.id=$1 AND s.id=$2`, [order, observationId]);
    assert.equal(linked.order_field, field);
    assert.equal(linked.observed_field, field);
    assert.equal(linked.linked_run, run);
    assert.equal(linked.linked_campaign, campaignField);
    assert.equal(linked.review_status, 'verified');
    assert.equal((await count(`SELECT count(*)::int AS n
      FROM work_order_observation_origins WHERE work_order_id=$1`, [order])).n, 1);
    const point = await count('SELECT ST_X(point) AS lon, ST_Y(point) AS lat FROM scouting_observations WHERE id=$1',
      [observationId]);
    assert.equal(point.lon, gps.coordinates[0]);
    assert.equal(point.lat, gps.coordinates[1]);

    // Test FORCE RLS using a real non-owner runtime database connection.
    for (const [tenant, expected] of [[tenantA, 1], [tenantB, 0]]) {
      await runtime.query('BEGIN');
      try {
        await runtime.query("SELECT set_config('app.current_tenant',$1,true)", [tenant]);
        const result = await runtime.query(
          'SELECT count(*)::int AS n FROM scouting_observations WHERE id=$1', [observationId]);
        assert.equal(result.rows[0].n, expected);
        const originRows = await runtime.query(
          'SELECT count(*)::int AS n FROM work_order_observation_origins WHERE work_order_id=$1',
          [order]);
        assert.equal(originRows.rows[0].n, expected,
          'non-owner FORCE RLS must conceal cross-tenant provenance');
      } finally {
        await runtime.query('ROLLBACK');
      }
    }
  } finally {
    if (runtimeConnected) await runtime.end();
    if (ownerConnected) {
      if (tenants.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])',
        [tenants]).catch(() => {});
      if (users.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])',
        [users]).catch(() => {});
      await owner.end();
    }
  }
});
