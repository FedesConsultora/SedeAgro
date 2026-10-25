// Test durable work-order creation through real HTTP/PostGIS with FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('workOrderCreateIdempotency needs disposable *_test DB URLs');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'work-order-create-replay-ci-only';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('durable work order key replays once, protects actor and survives deletion', async t => {
  const admin = new pg.Client({ connectionString: adminUrl });
  const app = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/v1/work-orders';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerReady = false, appReady = false;
  const insert = async (q, args) => (await admin.query(q, args)).rows[0].id;
  const send = async (identity, tid, body) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + identity.token,
        'x-tenant-id': tid, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await admin.connect(); ownerReady = true;
    await app.connect(); appReady = true;
    const [{ db }] = (await admin.query('SELECT current_database() AS db')).rows;
    const [{ app_db, ...role }] = (await app.query(`
      SELECT current_database() AS app_db,r.rolname,r.rolsuper,r.rolbypassrls,
        r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(app_db, db);
    assert.ok(isSafeRuntimeDbRole(role));
    const policies = (await admin.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.work_orders'::regclass,
        'public.work_order_create_requests'::regclass])
    `)).rows;
    assert.equal(policies.length, 2);
    for (const row of policies) assert.ok(row.relrowsecurity && row.relforcerowsecurity, row.relname);

    const plan = (await admin.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function tenant(tag) {
      const id = await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, 'Order replay ' + tag, 'wo-replay-' + tag + '-' + suffix]);
      tenants.push(id);
      await admin.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES($1,'work_orders',true,'plan')",
        [id]);
      return id;
    }
    const a = await tenant('a'), b = await tenant('b');
    async function member(tid, label, role) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label, 'wo-replay-' + suffix + '-' + label.replaceAll(' ', '-') + '@example.test']);
      users.push(id);
      await admin.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid, id, role]);
      return { id, token: signSession({ sub: id, tenant_id: tid, role_code: role }) };
    }
    const owner = await member(a, 'admin a', 'tenant_admin');
    const second = await member(a, 'other a', 'tenant_admin');
    const scout = await member(a, 'scout a', 'scout');
    const ownerB = await member(b, 'admin b', 'tenant_admin');
    async function field(tid, label) {
      const farm = await insert(
        'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tid, 'Farm ' + label]);
      return insert(
        'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tid, farm, 'Field ' + label]);
    }
    const fieldA = await field(a, suffix + ' a');
    const fieldB = await field(b, suffix + ' b');
    const key = randomUUID();
    const body = {
      client_request_id: key,
      field_id: fieldA,
      type: 'inspection',
      priority: 'high',
      due_at: '2026-11-01T12:00:00.000Z',
      title: 'Inspección lote ' + suffix,
      instructions: 'Revisar observaciones pendientes'
    };
    const forbidden = await send(scout, a, body);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    const foreign = await send(owner, a, { ...body, field_id: fieldB });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal((await admin.query(
      'SELECT count(*)::int AS n FROM work_order_create_requests WHERE tenant_id=$1',
      [a])).rows[0].n, 0);

    const created = await send(owner, a, body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.replayed, false);
    assert.equal(created.body.data.requested_by, owner.id);
    const id = created.body.data.id;
    const replay = await send(owner, a, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.data.id, id);

    const changed = await send(owner, a, { ...body, instructions: 'Different instruction' });
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.error.code, 'WORK_ORDER_CREATE_REQUEST_CONFLICT');
    const changedField = await send(owner, a, { ...body, field_id: fieldB });
    assert.equal(changedField.status, 409, JSON.stringify(changedField.body));
    const sameInstant = await send(owner, a, {
      ...body, due_at: '2026-11-01T09:00:00-03:00'
    });
    assert.equal(sameInstant.status, 200, JSON.stringify(sameInstant.body));
    assert.equal(sameInstant.body.data.id, id);

    const anotherActor = await send(second, a, {
      ...body, title: 'Another actor ' + suffix
    });
    assert.equal(anotherActor.status, 201, JSON.stringify(anotherActor.body));
    assert.notEqual(anotherActor.body.data.id, id);
    const anotherTenant = await send(ownerB, b, {
      ...body, title: 'Another tenant ' + suffix, field_id: fieldB
    });
    assert.equal(anotherTenant.status, 201, JSON.stringify(anotherTenant.body));

    const parallelBody = {
      ...body, client_request_id: randomUUID(), title: 'Concurrent ' + suffix
    };
    const responses = await Promise.all([
      send(owner, a, parallelBody), send(owner, a, parallelBody)
    ]);
    assert.deepEqual(responses.map(x => x.status).sort(), [200, 201],
      JSON.stringify(responses));
    assert.equal(responses[0].body.data.id, responses[1].body.data.id);
    const legacy = await send(owner, a, {
      field_id: fieldA, type: 'inspection', title: 'Legacy ' + suffix
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    assert.equal(legacy.body.replayed, undefined);

    const receipts = (await admin.query(
      'SELECT requested_by,work_order_id FROM work_order_create_requests WHERE tenant_id=$1 AND client_request_id=$2',
      [a, key])).rows;
    assert.equal(receipts.length, 2);
    assert.ok(receipts.some(x => x.requested_by === owner.id && x.work_order_id === id));

    await admin.query("UPDATE work_orders SET status='pending_approval' WHERE id=$1", [id]);
    const changedOrder = await send(owner, a, body);
    assert.equal(changedOrder.status, 200);
    assert.equal(changedOrder.body.data.status, 'pending_approval');

    await admin.query(
      "UPDATE memberships SET status='blocked' WHERE tenant_id=$1 AND user_id=$2",
      [a, owner.id]);
    const revoked = await send(owner, a, body);
    assert.equal(revoked.status, 401, JSON.stringify(revoked.body));
    await admin.query(
      "UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2",
      [a, owner.id]);

    await admin.query('DELETE FROM work_orders WHERE id=$1', [id]);
    const tombstone = (await admin.query(
      'SELECT work_order_id FROM work_order_create_requests WHERE tenant_id=$1 AND requested_by=$2 AND client_request_id=$3',
      [a, owner.id, key])).rows[0];
    assert.equal(tombstone.work_order_id, null);
    const gone = await send(owner, a, body);
    assert.equal(gone.status, 409, JSON.stringify(gone.body));
    assert.equal(gone.body.error.code, 'WORK_ORDER_CREATE_RESULT_GONE');
  } finally {
    if (ownerReady) {
      try {
        if (tenants.length) await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await admin.end(); }
    }
    if (appReady) await app.end();
  }
});
