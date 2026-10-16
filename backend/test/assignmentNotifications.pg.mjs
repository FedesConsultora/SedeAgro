// Requires a migrated and seeded disposable PostgreSQL/PostGIS *_test database.
// Gate: TEST_DATABASE_ADMIN_URL=... TEST_DATABASE_APP_URL=... node --test test/assignmentNotifications.pg.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) {
  throw new Error('Assignment gate requires disposable PostgreSQL *_test admin and app URLs.');
}
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'assignment-notification-gate-only';

const { createApp } = await import('../src/app.js');
const { sequelize, setLocalTenant } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { createAssignmentNotification } = await import('../src/modules/notifications/assignmentNotifications.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');
const { Client } = pg;

test('assignment notifications: transactional writes, replay, ownership, RLS, rollback', async t => {
  const owner = new Client({ connectionString: adminUrl });
  const appClient = new Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const tenants = [];
  const users = [];
  let connected = false;
  let appConnected = false;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  async function insert(sql, args) {
    return (await owner.query(sql, args)).rows[0].id;
  }
  async function count(table, conditions, params) {
    const sql = `SELECT count(*)::int AS total FROM ${table} WHERE ${conditions}`;
    return (await owner.query(sql, params)).rows[0].total;
  }
  async function request(path, token, tenant, method = 'GET', body, extraHeaders = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenant,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  try {
    await owner.connect();
    connected = true;
    const [{ name }] = (await owner.query('SELECT current_database() AS name')).rows;
    assert.match(name, /(?:^|[_-])test(?:$|[_-])/i);
    await appClient.connect();
    appConnected = true;
    const [{ db, ...appRole }] = (await appClient.query(`
      SELECT current_database() AS db,
             r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
             pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.equal(db, name, 'Owner and app URLs must use the same disposable test DB');
    assert.ok(isSafeRuntimeDbRole(appRole),
      'Runtime DB connection must be a non-owner without RLS bypass privileges');
    const [policy] = (await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid='public.notifications'::regclass
    `)).rows;
    assert.ok(policy.relrowsecurity && policy.relforcerowsecurity,
      'Notifications table must enforce FORCE RLS');
    const [{ id: planId }] = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows;
    const [{ id: cropId }] = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows;
    assert.ok(planId && cropId, 'Global seeds are required before DB gate');

    const tenantA = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Alerts A',$1,'active',$2) RETURNING id",
      [`alerts-a-${suffix}`, planId]);
    tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Alerts B',$1,'active',$2) RETURNING id",
      [`alerts-b-${suffix}`, planId]);
    tenants.push(tenantB);
    async function addUser(name, role, tenant, { membershipStatus = 'active', userStatus = 'active' } = {}) {
      const id = await insert(
        'INSERT INTO users(full_name,email,password_hash,status) VALUES($1,$2,\'fixture\',$3) RETURNING id',
        [name, `alerts-${suffix}-${name.replaceAll(' ','-')}@example.test`, userStatus]);
      users.push(id);
      await owner.query(
        'INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,$4)',
        [tenant, id, role, membershipStatus]);
      return id;
    }
    const adminA = await addUser('admin a', 'tenant_admin', tenantA);
    const coordinatorA = await addUser('coordinator a', 'agronomic_coordinator', tenantA);
    const scout1 = await addUser('scout 1', 'scout', tenantA);
    const scout2 = await addUser('scout 2', 'scout', tenantA);
    const blockedScout = await addUser('scout blocked', 'scout', tenantA, { membershipStatus: 'blocked' });
    const contractor1 = await addUser('contractor 1', 'contractor', tenantA);
    const contractor2 = await addUser('contractor 2', 'contractor', tenantA);
    const blockedContractor = await addUser('contractor blocked', 'contractor', tenantA, { userStatus: 'blocked' });
    const adminB = await addUser('admin b', 'tenant_admin', tenantB);
    const contractorB = await addUser('contractor b', 'contractor', tenantB);

    for (const tenant of [tenantA, tenantB]) {
      await owner.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
          "($1,'gis',true,'plan'),($1,'campaigns',true,'plan')," +
          "($1,'scouting',true,'plan'),($1,'work_orders',true,'plan')",
        [tenant]);
    }
    const farmA = await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantA, `Field farm ${suffix}`]);
    const fieldA = await insert(
      'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
      [tenantA, farmA, `Field ${suffix}`]);
    const campaign = await insert(
      "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-01-01') RETURNING id",
      [tenantA, `Assignment campaign ${suffix}`]);
    const campaignField = await insert(
      'INSERT INTO campaign_fields(tenant_id,campaign_id,field_id,crop_type_id) VALUES($1,$2,$3,$4) RETURNING id',
      [tenantA, campaign, fieldA, cropId]);

    const token = (userId, role, tenant) => signSession({
      sub: userId, role_code: role, tenant_id: tenant
    });
    const adminToken = token(adminA, 'tenant_admin', tenantA);
    const coordinatorToken = token(coordinatorA, 'agronomic_coordinator', tenantA);
    const scoutToken = token(scout1, 'scout', tenantA);
    const scout2Token = token(scout2, 'scout', tenantA);
    const contractorToken = token(contractor1, 'contractor', tenantA);
    const contractor2Token = token(contractor2, 'contractor', tenantA);
    const adminBToken = token(adminB, 'tenant_admin', tenantB);
    const contractorBToken = token(contractorB, 'contractor', tenantB);

    // New scouting run with an assignee: notification is committed with the run.
    const created = await request('/scouting/runs', adminToken, tenantA, 'POST',
      { campaign_field_id: campaignField, assigned_to: scout1, summary: 'PRIVATE_FIELD_NOTES' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const runId = created.body.data.id;
    assert.equal(await count('notifications',
      'tenant_id=$1 AND user_id=$2 AND entity_type=$3 AND entity_id=$4',
      [tenantA, scout1, 'scouting_run', runId]), 1);
    const mine = await request('/notifications', scoutToken, tenantA);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0].entity_id, runId);
    assert.doesNotMatch(JSON.stringify(mine.body), /PRIVATE_FIELD_NOTES/);
    assert.equal((await request('/notifications', scout2Token, tenantA)).body.data.length, 0);
    assert.equal((await request('/notifications', adminBToken, tenantB)).body.data.length, 0);
    const notificationId = mine.body.data[0].id;
    assert.equal((await request(`/notifications/${notificationId}/read`,
      scout2Token, tenantA, 'PATCH')).status, 404);
    assert.equal((await request(`/notifications/${notificationId}/read`,
      contractorBToken, tenantB, 'PATCH')).status, 404);
    assert.equal((await request(`/notifications/${notificationId}/read`,
      scoutToken, tenantB, 'PATCH')).status, 403);
    const acknowledged = await request(`/notifications/${notificationId}/read`,
      scoutToken, tenantA, 'PATCH');
    assert.equal(acknowledged.status, 200);
    assert.ok(acknowledged.body.data.read_at);

    // A no-op PATCH is not a second assignment; a reassignment is.
    assert.equal((await request(`/scouting/runs/${runId}`, adminToken, tenantA, 'PATCH',
      { assigned_to: scout1 })).status, 200);
    assert.equal(await count('notifications', 'entity_id=$1', [runId]), 1);
    const reassigned = await request(`/scouting/runs/${runId}`, adminToken, tenantA, 'PATCH',
      { assigned_to: scout2 });
    assert.equal(reassigned.status, 200);
    assert.equal((await request(`/scouting/runs/${runId}`,
      scoutToken, tenantA)).status, 404);
    assert.equal((await request(`/scouting/runs/${runId}`,
      scout2Token, tenantA)).status, 200);
    assert.equal(await count('notifications', 'entity_id=$1', [runId]), 2);
    assert.equal((await request(`/scouting/runs/${runId}`, adminToken, tenantA, 'PATCH',
      { assigned_to: null })).status, 200);
    assert.equal(await count('notifications', 'entity_id=$1', [runId]), 2);
    const invalidScout = await request('/scouting/runs', adminToken, tenantA, 'POST',
      { campaign_field_id: campaignField, assigned_to: blockedScout });
    assert.equal(invalidScout.status, 422);
    assert.equal((await request('/scouting/runs', adminToken, tenantA, 'POST',
      { campaign_field_id: campaignField, assigned_to: contractorB })).status, 422);

    // Assignments are unique under order row-lock and the DB unique constraint.
    const orderResponse = await request('/work-orders', adminToken, tenantA, 'POST',
      { field_id: fieldA, type: 'inspection', title: 'Check gate assignment' });
    assert.equal(orderResponse.status, 201, JSON.stringify(orderResponse.body));
    const orderId = orderResponse.body.data.id;
    const route = `/work-orders/${orderId}/assignees`;
    const payload = { user_id: contractor1, responsibility: 'executor' };
    const first = await request(route, adminToken, tenantA, 'POST', payload);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const replay = await request(route, adminToken, tenantA, 'POST', payload);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal((await request(route, adminToken, tenantA, 'POST',
      { ...payload, responsibility: 'reviewer' })).status, 409);
    assert.equal(await count('work_order_assignees',
      'tenant_id=$1 AND work_order_id=$2 AND user_id=$3',
      [tenantA, orderId, contractor1]), 1);
    assert.equal(await count('notifications',
      'tenant_id=$1 AND user_id=$2 AND entity_id=$3',
      [tenantA, contractor1, orderId]), 1);
    assert.equal((await request('/notifications', contractorToken, tenantA)).body.data.length, 1);
    assert.equal((await request(`/work-orders/${orderId}`, contractorToken, tenantA)).status, 200);
    assert.equal((await request(`/work-orders/${orderId}`, contractor2Token, tenantA)).status, 404);

    const races = await Promise.all(Array.from({ length: 3 }, () =>
      request(route, adminToken, tenantA, 'POST',
        { user_id: contractor2, responsibility: 'executor' })));
    assert.deepEqual(races.map(x => x.status).sort(), [200, 200, 201]);
    assert.equal(await count('notifications',
      'tenant_id=$1 AND user_id=$2 AND entity_id=$3',
      [tenantA, contractor2, orderId]), 1);
    assert.equal(await count('work_order_assignees',
      'tenant_id=$1 AND user_id=$2 AND work_order_id=$3',
      [tenantA, contractor2, orderId]), 1);

    for (const bad of [blockedContractor, blockedScout, scout1, contractorB]) {
      const error = await request(route, adminToken, tenantA, 'POST',
        { user_id: bad, responsibility: 'executor' });
      assert.equal(error.status, 422, JSON.stringify(error.body));
      assert.equal(await count('notifications',
        'tenant_id=$1 AND user_id=$2 AND entity_id=$3', [tenantA, bad, orderId]), 0);
    }
    assert.equal((await request(route, adminBToken, tenantB, 'POST', payload)).status, 404);
    assert.equal((await request(`/work-orders/${orderId}`,
      contractorBToken, tenantB)).status, 404);
    assert.equal((await request('/notifications', adminBToken, tenantB)).body.data.length, 0);

    // A contractor cannot add executors. Every state change and new assignment
    // writes minimal audit metadata atomically, without duplicating replays.
    assert.equal((await request(route, contractorToken, tenantA, 'POST', payload)).status, 403);
    assert.equal(await count('audit_events',
      'tenant_id=$1 AND entity_id=$2 AND action=$3',
      [tenantA, orderId, 'work_order.assignee_added']), 2);
    for (const status of ['pending_approval', 'approved', 'assigned']) {
      const transition = await request(`/work-orders/${orderId}/status`,
        adminToken, tenantA, 'PATCH', { status });
      assert.equal(transition.status, 200, JSON.stringify(transition.body));
    }
    assert.equal(await count('audit_events',
      'tenant_id=$1 AND entity_id=$2 AND action=$3',
      [tenantA, orderId, 'work_order.status_changed']), 3);
    const frozenCount = await count('notifications', 'entity_id=$1', [orderId]);
    const frozen = await request(route, adminToken, tenantA, 'POST',
      { user_id: adminA, responsibility: 'executor' });
    assert.equal(frozen.status, 409, JSON.stringify(frozen.body));
    assert.equal(frozen.body.error.code, 'WORK_ORDER_ASSIGNMENT_CLOSED');
    assert.equal((await request(route, adminToken, tenantA, 'POST', payload)).status, 409);
    assert.equal(await count('notifications', 'entity_id=$1', [orderId]), frozenCount);
    assert.equal(await count('audit_events',
      'tenant_id=$1 AND entity_id=$2 AND action=$3',
      [tenantA, orderId, 'work_order.assignee_added']), 2);

    // Membership may be revoked after assignment, before the order is ready.
    // A revoked executor never satisfies the approval -> assigned gate.
    const revocationOrder = await request('/work-orders', adminToken, tenantA, 'POST',
      { field_id: fieldA, type: 'inspection', title: 'Revoked executor gate' });
    assert.equal(revocationOrder.status, 201);
    const revokedId = revocationOrder.body.data.id;
    assert.equal((await request(`/work-orders/${revokedId}/assignees`,
      adminToken, tenantA, 'POST', { user_id: contractor2 },
      { 'x-request-id': 'not-a-uuid' })).status, 201);
    const auditCorrelation = (await owner.query(`SELECT request_id FROM audit_events
      WHERE tenant_id=$1 AND entity_id=$2 AND action='work_order.assignee_added'`,
      [tenantA, revokedId])).rows;
    assert.equal(auditCorrelation.length, 1);
    assert.equal(auditCorrelation[0].request_id, null);
    for (const status of ['pending_approval', 'approved']) {
      assert.equal((await request(`/work-orders/${revokedId}/status`,
        adminToken, tenantA, 'PATCH', { status })).status, 200);
    }
    await owner.query(`UPDATE memberships SET status='blocked'
      WHERE tenant_id=$1 AND user_id=$2`, [tenantA, contractor2]);
    const denied = await request(`/work-orders/${revokedId}/status`,
      adminToken, tenantA, 'PATCH', { status: 'assigned' });
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'WORK_ORDER_ACTIVE_ASSIGNEE_REQUIRED');
    assert.equal((await request(`/work-orders/${revokedId}`,
      adminToken, tenantA)).body.data.status, 'approved');
    assert.equal(await count('audit_events',
      'tenant_id=$1 AND entity_id=$2 AND action=$3',
      [tenantA, revokedId, 'work_order.status_changed']), 2);
    await owner.query(`UPDATE memberships SET status='active'
      WHERE tenant_id=$1 AND user_id=$2`, [tenantA, contractor2]);
    assert.equal((await request(`/work-orders/${revokedId}/status`,
      adminToken, tenantA, 'PATCH', { status: 'assigned' })).status, 200);

    // 0T.9: a status click is not evidence of execution. The actual operator
    // submits declared observations; another authorized person reviews them.
    const inProgress = await request(`/work-orders/${orderId}/status`,
      contractorToken, tenantA, 'PATCH', { status: 'in_progress' });
    assert.equal(inProgress.status, 200, JSON.stringify(inProgress.body));
    const premature = await request(`/work-orders/${orderId}/status`,
      adminToken, tenantA, 'PATCH', { status: 'completed' });
    assert.equal(premature.status, 409);
    assert.equal(premature.body.error.code, 'WORK_ORDER_EXECUTION_REVIEW_REQUIRED');
    assert.equal((await request(`/work-orders/${orderId}/status`,
      contractorToken, tenantA, 'PATCH', { status: 'completed' })).status, 403);

    const reportedStart = new Date(new Date(inProgress.body.data.approved_at).getTime() + 100);
    const reportedFinish = new Date(reportedStart.getTime() + 200);
    const executionPayload = {
      started_at: reportedStart.toISOString(), finished_at: reportedFinish.toISOString(),
      worked_area_hectares: 2.25, result_summary: 'Se realizó inspección visual del lote informado.'
    };
    const executionRoute = `/work-orders/${orderId}/executions`;
    assert.equal((await request(executionRoute, contractorBToken, tenantB,
      'POST', executionPayload)).status, 404);
    assert.equal((await request(executionRoute, scoutToken, tenantA,
      'POST', executionPayload)).status, 403);
    assert.equal((await request(executionRoute, contractorToken, tenantA,
      'POST', { ...executionPayload, worked_area_hectares: 0 })).status, 422);
    assert.equal((await request(executionRoute, contractorToken, tenantA,
      'POST', { ...executionPayload, finished_at: new Date(Date.now() + 86400000).toISOString() })).status, 422);
    const recorded = await request(executionRoute, contractorToken, tenantA,
      'POST', executionPayload);
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    const firstReportId = recorded.body.data.id;
    assert.equal(recorded.body.data.review_status, 'submitted');
    assert.equal(recorded.body.data.submitted_by, contractor1);
    // 0T.10: the very same private BYTEA storage powers order execution
    // attachments. No scouting permission or evidence can cross the boundary.
    const privatePdf = Buffer.from('%PDF-1.4\\n1 0 obj<</Type /Catalog>>endobj\\n%%EOF\\n'.replaceAll('\\n', '\n'));
    const evidenceUrl = `/work-orders/${orderId}/executions/${firstReportId}/evidence`;
    const filePayload = { kind: 'document', mime_type: 'application/pdf',
      original_name: 'parte.pdf', content_base64: privatePdf.toString('base64'),
      client_upload_id: randomUUID() };
    assert.equal((await request(evidenceUrl, contractorBToken, tenantB,
      'POST', filePayload)).status, 404);
    assert.equal((await request(evidenceUrl, contractor2Token, tenantA,
      'POST', filePayload)).status, 403);
    assert.equal((await request(evidenceUrl, adminToken, tenantA,
      'POST', filePayload)).status, 403);
    assert.equal((await request(evidenceUrl, scoutToken, tenantA,
      'POST', filePayload)).status, 403);
    assert.equal((await request(evidenceUrl, contractorToken, tenantA,
      'POST', { ...filePayload, content_base64: Buffer.from('NOT A PDF').toString('base64') })).status, 422);
    const storedFile = await request(evidenceUrl, contractorToken, tenantA,
      'POST', filePayload);
    assert.equal(storedFile.status, 201, JSON.stringify(storedFile.body));
    assert.equal(storedFile.body.replayed, false);
    const evidenceId = storedFile.body.data.id;
    assert.equal(storedFile.body.data.work_order_execution_id, firstReportId);
    assert.doesNotMatch(JSON.stringify(storedFile.body), /content_sha256|content_base64|storage_key/);
    const replayFile = await request(evidenceUrl, contractorToken, tenantA,
      'POST', filePayload);
    assert.equal(replayFile.status, 200);
    assert.equal(replayFile.body.replayed, true);
    assert.equal(replayFile.body.data.id, evidenceId);
    assert.equal((await request(evidenceUrl, contractorToken, tenantA,
      'POST', { ...filePayload, original_name: 'different.pdf' })).status, 409);
    const listPath = `/work-orders/${orderId}/execution-evidence`;
    const evidenceList = await request(listPath, contractorToken, tenantA);
    assert.equal(evidenceList.status, 200);
    assert.equal(evidenceList.body.data.length, 1);
    assert.equal(evidenceList.body.data[0].id, evidenceId);
    assert.equal((await request(listPath, contractorBToken, tenantB)).status, 404);
    assert.equal((await request(listPath, scoutToken, tenantA)).status, 403);
    const contentRoute = `/work-orders/${orderId}/evidence/${evidenceId}/content`;
    const integrityRoute = `/work-orders/${orderId}/evidence/${evidenceId}/integrity`;
    const download = await request(contentRoute, contractorToken, tenantA);
    assert.equal(download.status, 200, JSON.stringify(download.body));
    assert.deepEqual(Buffer.from(download.body.data.content_base64, 'base64'), privatePdf);
    assert.match(download.headers.get('cache-control'), /no-store/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await request(contentRoute, contractorBToken, tenantB)).status, 404);
    assert.equal((await request(contentRoute, scoutToken, tenantA)).status, 403);
    assert.equal((await request(`/work-orders/${orderId}/evidence/${randomUUID()}/content`,
      contractorToken, tenantA)).status, 404);
    const firstIntegrity = await request(integrityRoute, contractorToken, tenantA);
    assert.equal(firstIntegrity.status, 200);
    assert.deepEqual(firstIntegrity.body.data, { id: evidenceId, status: 'verified' });
    assert.equal(await count('evidence_blobs', 'tenant_id=$1 AND evidence_id=$2',
      [tenantA, evidenceId]), 1);
    // Wrong execution/order cannot be assigned even by a database owner: FK
    // verifies all three keys as one compound reference.
    await assert.rejects(owner.query(
      'UPDATE evidence_assets SET work_order_execution_id=$1 WHERE id=$2',
      [randomUUID(), evidenceId]), error => error.code === '23503');
    // A damaged BYTEA must never be silently returned as a verified download.
    await owner.query('UPDATE evidence_blobs SET content=$1 WHERE evidence_id=$2',
      [Buffer.from('DAMAGED'), evidenceId]);
    assert.equal((await request(integrityRoute, contractorToken, tenantA)).body.data.status, 'mismatch');
    assert.equal((await request(contentRoute, contractorToken, tenantA)).status, 409);
    await owner.query('UPDATE evidence_blobs SET content=$1 WHERE evidence_id=$2',
      [privatePdf, evidenceId]);
    assert.equal((await request(integrityRoute, contractorToken, tenantA)).body.data.status, 'verified');
    // Locked to 8 blobs, including replays that do not increment counters.
    for (let n = 1; n < 8; n++) {
      const extra = await request(evidenceUrl, contractorToken, tenantA, 'POST',
        { ...filePayload, client_upload_id: randomUUID(), original_name: `parte-${n}.pdf` });
      assert.equal(extra.status, 201, JSON.stringify(extra.body));
    }
    assert.equal((await request(evidenceUrl, contractorToken, tenantA, 'POST',
      { ...filePayload, client_upload_id: randomUUID(), original_name: 'ninth.pdf' })).status, 409);
    assert.equal(await count('evidence_assets',
      'tenant_id=$1 AND work_order_execution_id=$2', [tenantA, firstReportId]), 8);
    assert.equal(await count('audit_events',
      "tenant_id=$1 AND entity_id=$2 AND action='work_order.execution_evidence_uploaded'",
      [tenantA, orderId]), 8);
    // Revocation invalidates new downloads regardless of prior upload success.
    await owner.query("UPDATE memberships SET status='blocked' WHERE tenant_id=$1 AND user_id=$2",
      [tenantA, contractor1]);
    assert.equal((await request(contentRoute, contractorToken, tenantA)).status, 401);
    await owner.query("UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2",
      [tenantA, contractor1]);
    assert.equal((await request(executionRoute, contractorToken, tenantA,
      'POST', executionPayload)).status, 409);
    assert.equal((await request(`/work-orders/${orderId}`,
      contractorToken, tenantA)).body.data.WorkOrderExecutions.length, 1);
    assert.equal((await request(`/work-orders/${orderId}`,
      adminBToken, tenantB)).status, 404);
    assert.equal((await request(`/work-orders/${orderId}/status`,
      adminToken, tenantA, 'PATCH', { status: 'completed' })).status, 409);
    assert.equal(await count('audit_events',
      "tenant_id=$1 AND entity_id=$2 AND action='work_order.execution_submitted'",
      [tenantA, orderId]), 1);
    const reviewRoute = `${executionRoute}/${firstReportId}/review`;
    const checkedReviewNoFiles = { time_checked: true, area_checked: true,
      result_checked: true, operation_checked: true, evidence_basis: 'no_files' };
    const checkedReviewWithFiles = { ...checkedReviewNoFiles, evidence_basis: 'reviewed_files' };
    assert.equal((await request(reviewRoute, contractorToken, tenantA,
      'POST', { decision: 'verified', checklist: checkedReviewWithFiles })).status, 403);
    assert.equal((await request(reviewRoute, adminBToken, tenantB,
      'POST', { decision: 'verified', checklist: checkedReviewWithFiles })).status, 404);
    assert.equal((await request(reviewRoute, adminToken, tenantA,
      'POST', { decision: 'rejected' })).status, 422);
    const rejected = await request(reviewRoute, adminToken, tenantA,
      'POST', { decision: 'rejected', reason: 'Falta validar superficie realmente recorrida.' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.review_status, 'rejected');
    assert.equal((await request(reviewRoute, adminToken, tenantA,
      'POST', { decision: 'verified', checklist: checkedReviewWithFiles })).status, 409);

    const corrected = await request(executionRoute, contractor2Token, tenantA,
      'POST', { ...executionPayload, worked_area_hectares: 2.5,
        result_summary: 'Inspección corregida luego de revisar la superficie.' });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
    const correctedId = corrected.body.data.id;
    const correctedReviewUrl = `${executionRoute}/${correctedId}/review`;
    assert.equal((await request(correctedReviewUrl, adminToken, tenantA, 'POST',
      { decision: 'verified' })).status, 422,
    'No positive verification without an explicit reviewer checklist');
    assert.equal((await request(correctedReviewUrl, adminToken, tenantA, 'POST',
      { decision: 'verified', checklist: { ...checkedReviewNoFiles, area_checked: false } })).status, 422);
    assert.equal((await request(correctedReviewUrl, adminToken, tenantA, 'POST',
      { decision: 'verified', checklist: checkedReviewWithFiles })).status, 409,
    'Cannot say files were reviewed if the report has none');
    const verified = await request(correctedReviewUrl,
      adminToken, tenantA, 'POST', { decision: 'verified', checklist: checkedReviewNoFiles });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.data.review_status, 'verified');
    assert.deepEqual(verified.body.data.review_checklist, checkedReviewNoFiles);
    const history = await request(`/work-orders/${orderId}`, adminToken, tenantA);
    assert.equal(history.status, 200);
    assert.equal(history.body.data.WorkOrderExecutions.length, 2);
    assert.deepEqual(new Set(history.body.data.WorkOrderExecutions.map(x => x.review_status)),
      new Set(['rejected', 'verified']));
    assert.equal((await request(`/work-orders/${orderId}/status`,
      contractorToken, tenantA, 'PATCH', { status: 'completed' })).status, 403);
    const completed = await request(`/work-orders/${orderId}/status`,
      coordinatorToken, tenantA, 'PATCH', { status: 'completed' });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.ok(completed.body.data.completed_at);
    // Replays survive closure without creating a second blob; a new upload
    // after the report was rejected and the order completed stays denied.
    const closedReplay = await request(evidenceUrl, contractorToken, tenantA,
      'POST', filePayload);
    assert.equal(closedReplay.status, 200);
    assert.equal(closedReplay.body.replayed, true);
    assert.equal((await request(evidenceUrl, contractorToken, tenantA,
      'POST', { ...filePayload, client_upload_id: randomUUID() })).status, 409);
    assert.equal((await request(contentRoute, contractorToken, tenantA)).status, 200);
    assert.equal((await request(executionRoute, contractorToken, tenantA,
      'POST', executionPayload)).status, 409);
    assert.equal(await count('audit_events',
      "tenant_id=$1 AND entity_id=$2 AND action='work_order.execution_reviewed'",
      [tenantA, orderId]), 2);
    // Runtime role must not read another tenant's declarations, even with a known UUID.
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant',$1,true)", [tenantB]);
    assert.equal((await appClient.query('SELECT id FROM work_order_executions WHERE id=$1',
      [correctedId])).rowCount, 0);
    await appClient.query('ROLLBACK');

    // Admin authors cannot self-review, even though their role can review others.
    const selfOrder = await request('/work-orders', adminToken, tenantA, 'POST',
      { field_id: fieldA, type: 'inspection', title: 'Two-person review' });
    const selfOrderId = selfOrder.body.data.id;
    assert.equal((await request(`/work-orders/${selfOrderId}/assignees`, adminToken,
      tenantA, 'POST', { user_id: adminA })).status, 201);
    for (const status of ['pending_approval', 'approved', 'assigned', 'in_progress']) {
      assert.equal((await request(`/work-orders/${selfOrderId}/status`,
        adminToken, tenantA, 'PATCH', { status })).status, 200);
    }
    const selfLive = await request(`/work-orders/${selfOrderId}`, adminToken, tenantA);
    const selfStart = new Date(new Date(selfLive.body.data.approved_at).getTime() + 100);
    const selfReport = await request(`/work-orders/${selfOrderId}/executions`,
      adminToken, tenantA, 'POST', {
        ...executionPayload, started_at: selfStart.toISOString(),
        finished_at: new Date(selfStart.getTime() + 100).toISOString()
      });
    assert.equal(selfReport.status, 201, JSON.stringify(selfReport.body));
    const selfReviewPath = `/work-orders/${selfOrderId}/executions/${selfReport.body.data.id}/review`;
    assert.equal((await request(selfReviewPath, adminToken, tenantA, 'POST',
      { decision: 'verified', checklist: checkedReviewNoFiles })).status, 403);
    assert.equal((await request(selfReviewPath, coordinatorToken, tenantA, 'POST',
      { decision: 'verified', checklist: checkedReviewNoFiles })).status, 200);

    // 0T.11: an application requires an authentic bounded private file, not
    // merely a human checkbox. Corruption must block approval before completion.
    const treatment = await request('/work-orders', adminToken, tenantA, 'POST',
      { field_id: fieldA, type: 'application', title: 'Application proof-gate fixture' });
    assert.equal(treatment.status, 201);
    const applicationId = treatment.body.data.id;
    assert.equal((await request(`/work-orders/${applicationId}/assignees`, adminToken, tenantA,
      'POST', { user_id: contractor2 })).status, 201);
    for (const status of ['pending_approval', 'approved', 'assigned', 'in_progress']) {
      const moved = await request(`/work-orders/${applicationId}/status`,
        adminToken, tenantA, 'PATCH', { status });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
    }
    const applicationDetail = await request(`/work-orders/${applicationId}`, adminToken, tenantA);
    const applicationStart = new Date(new Date(applicationDetail.body.data.approved_at).getTime() + 50);
    const applicationReport = await request(`/work-orders/${applicationId}/executions`,
      contractor2Token, tenantA, 'POST', {
        ...executionPayload, started_at: applicationStart.toISOString(),
        finished_at: new Date(applicationStart.getTime() + 50).toISOString(),
        result_summary: 'Aplicación declarada; sin telemetría automática.'
      });
    assert.equal(applicationReport.status, 201, JSON.stringify(applicationReport.body));
    const appReportId = applicationReport.body.data.id;
    const applicationReview = `/work-orders/${applicationId}/executions/${appReportId}/review`;
    const applicationEvidence = `/work-orders/${applicationId}/executions/${appReportId}/evidence`;
    assert.equal((await request(applicationReview, adminToken, tenantA, 'POST',
      { decision: 'verified', checklist: checkedReviewNoFiles })).status, 409,
      'Application cannot be approved by acknowledging missing evidence');
    assert.equal((await request(applicationReview, adminToken, tenantA, 'POST',
      { decision: 'verified', checklist: checkedReviewWithFiles })).status, 409,
      'A fake reviewer checkbox does not replace a stored private blob');
    const appStored = await request(applicationEvidence, contractor2Token, tenantA,
      'POST', { ...filePayload, client_upload_id: randomUUID(), original_name: 'tratamiento.pdf' });
    assert.equal(appStored.status, 201, JSON.stringify(appStored.body));
    const appEvidenceId = appStored.body.data.id;
    await owner.query('UPDATE evidence_blobs SET content=$1 WHERE evidence_id=$2',
      [Buffer.from('TAMPERED'), appEvidenceId]);
    const failedReview = await request(applicationReview, adminToken, tenantA,
      'POST', { decision: 'verified', checklist: checkedReviewWithFiles });
    assert.equal(failedReview.status, 409, JSON.stringify(failedReview.body));
    assert.equal(failedReview.body.error.code, 'EXECUTION_REVIEW_EVIDENCE_INTEGRITY_FAILED');
    assert.equal((await request(`/work-orders/${applicationId}`, adminToken, tenantA))
      .body.data.WorkOrderExecutions[0].review_status, 'submitted');
    await owner.query('UPDATE evidence_blobs SET content=$1 WHERE evidence_id=$2',
      [privatePdf, appEvidenceId]);
    const applicationAccepted = await request(applicationReview, adminToken, tenantA,
      'POST', { decision: 'verified', checklist: checkedReviewWithFiles });
    assert.equal(applicationAccepted.status, 200, JSON.stringify(applicationAccepted.body));
    assert.deepEqual(applicationAccepted.body.data.review_checklist, checkedReviewWithFiles);
    assert.equal((await request(`/work-orders/${applicationId}/status`,
      adminToken, tenantA, 'PATCH', { status: 'completed' })).status, 200);
    assert.equal(await count('audit_events',
      "tenant_id=$1 AND entity_id=$2 AND action='work_order.execution_reviewed'",
      [tenantA, applicationId]), 1);

    // 0T.12: planning is separate from immutable operator-declared use.
    // This is not an actual stock movement or agronomic dosage reading.
    const catalogOne = await request('/assets/inputs', adminToken, tenantA, 'POST',
      { name: 'Fertilizante de prueba', category: 'fertilizer', unit: 'kg' });
    const catalogTwo = await request('/assets/inputs', adminToken, tenantA, 'POST',
      { name: 'Adyuvante de prueba', category: 'adjuvant', unit: 'L' });
    assert.equal(catalogOne.status, 201);
    assert.equal(catalogTwo.status, 201);
    const otherTenantCatalog = await request('/assets/inputs', adminBToken, tenantB, 'POST',
      { name: 'Insumo ajeno', category: 'fertilizer', unit: 'kg' });
    assert.equal(otherTenantCatalog.status, 201);
    const materialOrder = await request('/work-orders', adminToken, tenantA, 'POST',
      { field_id: fieldA, type: 'fertilization', title: 'Declaración de insumos' });
    assert.equal(materialOrder.status, 201);
    const materialOrderId = materialOrder.body.data.id;
    const plannedPath = `/work-orders/${materialOrderId}/inputs`;
    const planOne = await request(plannedPath, adminToken, tenantA, 'POST',
      { input_id: catalogOne.body.data.id, total_quantity: 6.5 });
    const planTwo = await request(plannedPath, adminToken, tenantA, 'POST',
      { input_id: catalogTwo.body.data.id, total_quantity: 2 });
    assert.equal(planOne.status, 201, JSON.stringify(planOne.body));
    assert.equal(planTwo.status, 201, JSON.stringify(planTwo.body));
    assert.equal((await request(plannedPath, adminToken, tenantA, 'POST',
      { input_id: otherTenantCatalog.body.data.id, total_quantity: 100 })).status, 422);
    assert.equal((await request(`/work-orders/${materialOrderId}/assignees`, adminToken, tenantA,
      'POST', { user_id: contractor2 })).status, 201);
    for (const status of ['pending_approval', 'approved', 'assigned', 'in_progress']) {
      const moved = await request(`/work-orders/${materialOrderId}/status`,
        adminToken, tenantA, 'PATCH', { status });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
    }
    assert.equal((await request(plannedPath, adminToken, tenantA, 'POST',
      { input_id: catalogOne.body.data.id, total_quantity: 6.5 })).status, 409,
      'Even identical planning replay must not mutate an approved plan');
    const materialDetail = await request(`/work-orders/${materialOrderId}`, adminToken, tenantA);
    assert.equal(materialDetail.body.data.WorkOrderInputs.length, 2);
    const materialStart = new Date(new Date(materialDetail.body.data.approved_at).getTime() + 50);
    const materialReport = await request(`/work-orders/${materialOrderId}/executions`,
      contractor2Token, tenantA, 'POST', { ...executionPayload,
        started_at: materialStart.toISOString(),
        finished_at: new Date(materialStart.getTime() + 50).toISOString(),
        result_summary: 'Declaro insumos utilizados durante el trabajo de fertilización.' });
    assert.equal(materialReport.status, 201, JSON.stringify(materialReport.body));
    const materialReportId = materialReport.body.data.id;
    const materialEvidence = await request(
      `/work-orders/${materialOrderId}/executions/${materialReportId}/evidence`,
      contractor2Token, tenantA, 'POST',
      { ...filePayload, client_upload_id: randomUUID(), original_name: 'fertilizacion.pdf' });
    assert.equal(materialEvidence.status, 201);
    const materialReview = `/work-orders/${materialOrderId}/executions/${materialReportId}/review`;
    const prematureMaterialsReview = await request(materialReview, adminToken, tenantA,
      'POST', { decision: 'verified', checklist: checkedReviewWithFiles });
    assert.equal(prematureMaterialsReview.status, 409);
    assert.equal(prematureMaterialsReview.body.error.code, 'EXECUTION_INPUT_DECLARATION_REQUIRED');
    const declarePath = `/work-orders/${materialOrderId}/executions/${materialReportId}/input-declaration`;
    const clientDeclarationId = randomUUID();
    const quantities = {
      client_declaration_id: clientDeclarationId,
      notes: 'Menos líquido por cambios observados en el lote.',
      items: [
        { work_order_input_id: planOne.body.data.id, declared_quantity: '6.5000' },
        { work_order_input_id: planTwo.body.data.id, declared_quantity: '0.5000' }
      ]
    };
    assert.equal((await request(declarePath, adminBToken, tenantB, 'POST', quantities)).status, 404);
    assert.equal((await request(declarePath, scoutToken, tenantA, 'POST', quantities)).status, 403);
    assert.equal((await request(declarePath, contractorToken, tenantA, 'POST', quantities)).status, 404,
      'Unassigned contractor must not learn that this order exists');
    assert.equal((await request(declarePath, adminToken, tenantA, 'POST', quantities)).status, 403);
    assert.equal((await request(declarePath, contractor2Token, tenantA, 'POST',
      { ...quantities, items: quantities.items.slice(0, 1) })).status, 422);
    assert.equal((await request(declarePath, contractor2Token, tenantA, 'POST',
      { ...quantities, items: [quantities.items[0], quantities.items[0]] })).status, 422);
    assert.equal((await request(declarePath, contractor2Token, tenantA, 'POST',
      { ...quantities, notes: '' })).status, 422);
    assert.equal((await request(declarePath, contractor2Token, tenantA, 'POST',
      { ...quantities, items: quantities.items.map((x, i) => ({ ...x,
        declared_quantity: i === 1 ? '-5' : x.declared_quantity })) })).status, 422);
    const firstDeclaration = await request(declarePath, contractor2Token, tenantA,
      'POST', quantities);
    assert.equal(firstDeclaration.status, 201, JSON.stringify(firstDeclaration.body));
    assert.equal(firstDeclaration.body.replayed, false);
    const declared = firstDeclaration.body.data.input_declaration;
    assert.equal(declared.declared_by, contractor2);
    assert.equal(declared.items.length, 2);
    const fertilizer = declared.items.find(x => x.input_id === catalogOne.body.data.id);
    const adjuvant = declared.items.find(x => x.input_id === catalogTwo.body.data.id);
    assert.deepEqual([fertilizer.planned_quantity, fertilizer.declared_quantity,
      fertilizer.variance_quantity, fertilizer.unit], ['6.5', '6.5', '0', 'kg']);
    assert.deepEqual([adjuvant.planned_quantity, adjuvant.declared_quantity,
      adjuvant.variance_quantity, adjuvant.unit], ['2', '0.5', '-1.5', 'L']);
    const retryDeclared = await request(declarePath, contractor2Token, tenantA, 'POST', quantities);
    assert.equal(retryDeclared.status, 200);
    assert.equal(retryDeclared.body.replayed, true);
    assert.equal((await request(declarePath, contractor2Token, tenantA, 'POST',
      { ...quantities, client_declaration_id: randomUUID() })).status, 409);
    assert.equal((await request(declarePath, contractor2Token, tenantA, 'POST',
      { ...quantities, items: quantities.items.map(item => ({
        ...item, declared_quantity: '0'
      })) })).status, 409);
    assert.equal(await count('audit_events',
      "tenant_id=$1 AND entity_id=$2 AND action='work_order.execution_inputs_declared'",
      [tenantA, materialOrderId]), 1);
    const acceptedMaterialReport = await request(materialReview, adminToken, tenantA,
      'POST', { decision: 'verified', checklist: checkedReviewWithFiles });
    assert.equal(acceptedMaterialReport.status, 200, JSON.stringify(acceptedMaterialReport.body));
    assert.deepEqual(acceptedMaterialReport.body.data.input_declaration.items, declared.items);
    assert.equal((await request(`/work-orders/${materialOrderId}/status`,
      adminToken, tenantA, 'PATCH', { status: 'completed' })).status, 200);
    assert.equal((await request(declarePath, contractor2Token, tenantA,
      'POST', quantities)).body.replayed, true,
      'Idempotent retry remains safe after close');
    assert.equal((await request(declarePath, contractor2Token, tenantA, 'POST',
      { ...quantities, client_declaration_id: randomUUID() })).status, 409);
    assert.equal((await request(`/work-orders/${materialOrderId}`,
      adminBToken, tenantB)).status, 404,
      'Other tenant must not read persisted declared amounts');
    assert.equal(await count('work_order_inputs',
      'tenant_id=$1 AND work_order_id=$2', [tenantA, materialOrderId]), 2,
      'The declared quantities did not mutate planning');

    // Explicit transaction rollback: neither relationship nor notification survives.
    const rollbackOrder = await request('/work-orders', adminToken, tenantA, 'POST',
      { field_id: fieldA, type: 'inspection', title: 'Rollback fixture' });
    assert.equal(rollbackOrder.status, 201);
    const rollbackId = rollbackOrder.body.data.id;
    await assert.rejects(sequelize.transaction(async tx => {
      await setLocalTenant(tx, tenantA);
      await sequelize.query(
        'INSERT INTO work_order_assignees(tenant_id,work_order_id,user_id) VALUES($1,$2,$3)',
        { bind: [tenantA, rollbackId, contractor1], transaction: tx });
      await createAssignmentNotification({
        dbTransaction: tx, tenantId: tenantA
      }, { entityType: 'work_order', entityId: rollbackId, userId: contractor1 });
      throw new Error('force rollback after notification insert');
    }), /force rollback after notification insert/);
    assert.equal(await count('work_order_assignees', 'work_order_id=$1', [rollbackId]), 0);
    assert.equal(await count('notifications', 'entity_id=$1', [rollbackId]), 0);
  } finally {
    if (connected) {
      try {
        if (tenants.length) {
          await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
        }
        if (users.length) {
          await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
        }
      } finally { await owner.end(); }
    }
    if (appConnected) await appClient.end();
  }
});
