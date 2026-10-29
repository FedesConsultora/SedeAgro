// Exact-ACK campaign field assignment through real Express/PostGIS, FORCE RLS,
// independent actors, simultaneous requests, and deletion tombstones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('campaignFieldAssignIdempotency needs disposable *_test URLs');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'campaign-field-assign-replay-ci-only';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('field assignment stores an actor/tenant-scoped encrypted-client ACK without duplicate links', async t => {
  const admin = new pg.Client({ connectionString: adminUrl });
  const appDb = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const suffix = randomUUID().slice(0, 11);
  const tenants = [], users = [];
  let ownerReady = false, appReady = false;
  const insert = async (sql, params) => (await admin.query(sql, params)).rows[0].id;
  async function send(identity, tid, campaign, body) {
    const response = await fetch(base + '/campaigns/' + campaign + '/fields', {
      method: 'POST', headers: {
        authorization: 'Bearer ' + identity.token, 'x-tenant-id': tid,
        'content-type': 'application/json'
      }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json(),
      cache: response.headers.get('cache-control') };
  }
  try {
    await admin.connect(); ownerReady = true;
    await appDb.connect(); appReady = true;
    const [{ db }] = (await admin.query('SELECT current_database() AS db')).rows;
    const [{ app_db, ...role }] = (await appDb.query(`
      SELECT current_database() AS app_db,r.rolname,r.rolsuper,r.rolbypassrls,
        r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(app_db, db);
    assert.ok(isSafeRuntimeDbRole(role), 'app DB role may not bypass RLS');
    const rules = (await admin.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.campaign_field_assign_requests'::regclass,
        'public.campaign_fields'::regclass])
    `)).rows;
    assert.equal(rules.length, 2);
    for (const rule of rules) assert.ok(rule.relrowsecurity && rule.relforcerowsecurity, rule.relname);
    const plan = (await admin.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const crop = (await admin.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    assert.ok(plan && crop);
    async function tenant(tag) {
      const id = await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id, 'Assign pilot ' + tag, 'assign-pilot-' + tag + '-' + suffix]);
      tenants.push(id);
      await admin.query(
        "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES($1,'campaigns',true,'plan')",
        [id]);
      return id;
    }
    const a = await tenant('a'), b = await tenant('b');
    async function actor(tid, label, role) {
      const id = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label, 'assign-' + suffix + '-' + label.replaceAll(' ', '-') + '@example.test']);
      users.push(id);
      await admin.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid, id, role]);
      return { id, token: signSession({ sub: id, role_code: role, tenant_id: tid }) };
    }
    const adminA = await actor(a, 'admin a', 'tenant_admin');
    const coordA = await actor(a, 'coordinator a', 'agronomic_coordinator');
    const scoutA = await actor(a, 'scout a', 'scout');
    const adminB = await actor(b, 'admin b', 'tenant_admin');
    async function make(tid, tag) {
      const farm = await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tid, 'Farm ' + tag]);
      const field = await insert('INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tid, farm, 'Lot ' + tag]);
      const campaign = await insert(
        "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-09-01') RETURNING id",
        [tid, 'Season ' + tag]);
      return { field, campaign };
    }
    const aa = await make(a, 'A'), bb = await make(b, 'B');
    const otherField = await insert(
      'INSERT INTO fields(tenant_id,farm_id,name) SELECT tenant_id,farm_id,$2 FROM fields WHERE id=$1 RETURNING id',
      [aa.field, 'Other ' + suffix]);
    const key = randomUUID();
    const body = { client_request_id: key, field_id: aa.field,
      crop_type_id: crop.id, planting_date: '2026-10-02',
      harvest_target_date: '2027-02-10', expected_yield: 28.5, status: 'planned' };

    const denied = await send(scoutA, a, aa.campaign, body);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const invalid = await send(adminA, a, aa.campaign,
      { ...body, harvest_target_date: '2026-01-01' });
    assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
    assert.equal((await admin.query(
      'SELECT count(*)::int AS n FROM campaign_field_assign_requests WHERE tenant_id=$1',
      [a])).rows[0].n, 0);

    const created = await send(adminA, a, aa.campaign, body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.replayed, false);
    assert.equal(created.cache, 'private, no-store');
    const id = created.body.data.id;
    assert.equal(created.body.data.field_id, aa.field);
    const replay = await send(adminA, a, aa.campaign, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.data.id, id);
    assert.equal(replay.cache, 'private, no-store');

    const changed = await send(adminA, a, aa.campaign,
      { ...body, expected_yield: 29.5 });
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.error.code, 'CAMPAIGN_FIELD_REQUEST_CONFLICT');
    const moved = await send(adminA, a, bb.campaign, body);
    assert.equal(moved.status, 404, JSON.stringify(moved.body));
    const blockedField = await send(adminA, a, aa.campaign,
      { ...body, client_request_id: randomUUID(), field_id: bb.field });
    assert.equal(blockedField.status, 404);

    // Same identity is only replayable for this actor. A distinct key or
    // actor must never treat an existing field link as their own ACK.
    const differentKey = await send(adminA, a, aa.campaign,
      { ...body, client_request_id: randomUUID() });
    assert.equal(differentKey.status, 409, JSON.stringify(differentKey.body));
    assert.equal(differentKey.body.error.code, 'CAMPAIGN_FIELD_ALREADY_ASSIGNED');
    const otherActor = await send(coordA, a, aa.campaign, body);
    assert.equal(otherActor.status, 409, JSON.stringify(otherActor.body));
    assert.equal(otherActor.body.error.code, 'CAMPAIGN_FIELD_ALREADY_ASSIGNED');

    const sameKeyElsewhere = await send(adminB, b, bb.campaign,
      { ...body, field_id: bb.field });
    assert.equal(sameKeyElsewhere.status, 201, JSON.stringify(sameKeyElsewhere.body));
    assert.notEqual(sameKeyElsewhere.body.data.id, id);

    const simultaneousBody = {
      ...body, client_request_id: randomUUID(), field_id: otherField,
      expected_yield: 32.0
    };
    const parallel = await Promise.all([
      send(adminA, a, aa.campaign, simultaneousBody),
      send(adminA, a, aa.campaign, simultaneousBody)
    ]);
    assert.deepEqual(parallel.map(result => result.status).sort(), [200, 201],
      JSON.stringify(parallel));
    assert.equal(parallel[0].body.data.id, parallel[1].body.data.id);

    const rows = (await admin.query(
      'SELECT requested_by,campaign_field_id FROM campaign_field_assign_requests WHERE tenant_id=$1 AND client_request_id=$2',
      [a, key])).rows;
    assert.equal(rows.length, 1, 'different actors cannot claim original receipt');
    assert.equal(rows[0].requested_by, adminA.id);
    assert.equal(rows[0].campaign_field_id, id);
    assert.equal((await admin.query(
      'SELECT count(*)::int AS n FROM campaign_fields WHERE tenant_id=$1 AND campaign_id=$2',
      [a, aa.campaign])).rows[0].n, 2, 'no duplicates or confused field assignments');
    assert.equal((await admin.query(
      'SELECT count(*)::int AS n FROM campaign_field_assign_requests WHERE tenant_id=$1',
      [a])).rows[0].n, 2, 'failed duplicates roll back newly inserted receipts');

    // A historically valid link may be updated later. Receipt preserves the
    // immutable original ID rather than creating a second campaign-field.
    await admin.query("UPDATE campaign_fields SET status='active' WHERE id=$1", [id]);
    const afterUpdate = await send(adminA, a, aa.campaign, body);
    assert.equal(afterUpdate.status, 200);
    assert.equal(afterUpdate.body.data.id, id);
    assert.equal(afterUpdate.body.data.status, 'active');

    const oldMembership = await admin.query(
      "UPDATE memberships SET status='blocked' WHERE tenant_id=$1 AND user_id=$2",
      [a, adminA.id]);
    assert.equal(oldMembership.rowCount, 1);
    const revoked = await send(adminA, a, aa.campaign, body);
    assert.equal(revoked.status, 401, JSON.stringify(revoked.body));
    await admin.query(
      "UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2",
      [a, adminA.id]);
    await admin.query('DELETE FROM campaign_fields WHERE id=$1', [id]);
    const [tombstone] = (await admin.query(
      'SELECT campaign_field_id FROM campaign_field_assign_requests WHERE tenant_id=$1 AND requested_by=$2 AND client_request_id=$3',
      [a, adminA.id, key])).rows;
    assert.equal(tombstone.campaign_field_id, null);
    const gone = await send(adminA, a, aa.campaign, body);
    assert.equal(gone.status, 409, JSON.stringify(gone.body));
    assert.equal(gone.body.error.code, 'CAMPAIGN_FIELD_RESULT_GONE');
  } finally {
    if (ownerReady) {
      try {
        if (tenants.length) await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await admin.end(); }
    }
    if (appReady) await appDb.end();
  }
});
