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
    return { status: response.status, body: await response.json() };
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
