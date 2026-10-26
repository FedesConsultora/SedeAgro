// Disposable migrated PostGIS only, real HTTP, nonowner runtime under FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.TEST_DATABASE_ADMIN_URL || !process.env.TEST_DATABASE_APP_URL) {
  throw new Error('memberLifecycle.pg.mjs requires disposable PostGIS TEST DB credentials.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'member-lifecycle-test-only';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { hashPassword } = await import('../src/utils/password.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('live member lifecycle enforces tenant, role, capacity and session revocation', async t => {
  const owner = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  const runtime = new pg.Client({ connectionString: process.env.TEST_DATABASE_APP_URL });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/auth';
  let ownerConnected = false, runtimeConnected = false;
  const tenants = [], users = [];
  const inserted = async (sql,args) => (await owner.query(sql,args)).rows[0].id;
  async function send(path, { token, tenant, method='GET', body } = {}) {
    const response = await fetch(url + path, {
      method, headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(tenant ? { 'x-tenant-id': tenant } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : null };
  }
  try {
    await owner.connect(); ownerConnected = true;
    await runtime.connect(); runtimeConnected = true;
    const db = (await owner.query('SELECT current_database() db')).rows[0].db;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    const role = (await runtime.query(`
      SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
      pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows[0];
    assert.ok(isSafeRuntimeDbRole(role));
    const policy = (await owner.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.memberships'::regclass,'public.auth_sessions'::regclass])
    `)).rows;
    assert.equal(policy.length,2);
    assert.ok(policy.every(x=>x.relrowsecurity && x.relforcerowsecurity),JSON.stringify(policy));

    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function createTenant(tag) {
      const id = await inserted(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Lifecycle ' + tag,'lifecycle-' + tag + '-' + suffix]);
      tenants.push(id); return id;
    }
    const tenantA = await createTenant('a'), tenantB = await createTenant('b');
    async function makeMember(tenant,name,roleCode) {
      const email = name.replaceAll(' ','') + '-' + suffix + '@example.test';
      const password = 'StrongMemberPassword493';
      const userId = await inserted(
        'INSERT INTO users(email,full_name,password_hash) VALUES($1,$2,$3) RETURNING id',
        [email,name,await hashPassword(password)]);
      users.push(userId);
      const membershipId = await inserted(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active') RETURNING id",
        [tenant,userId,roleCode]);
      return { id: userId, membershipId, email,password,
        token: signSession({ sub: userId,tenant_id:tenant,role_code:roleCode }) };
    }
    const adminA = await makeMember(tenantA,'admin a','tenant_admin');
    const adminB = await makeMember(tenantB,'admin b','tenant_admin');
    const scout = await makeMember(tenantA,'scout a','scout');
    const change = (actor,tenant,memberId,status) =>
      send('/members/' + memberId + '/status', {
        method:'PATCH', token:actor.token, tenant, body:{ status }
      });

    assert.equal((await change(scout,tenantA,adminA.membershipId,'blocked')).status,403);
    assert.equal((await change(adminA,tenantA,adminA.membershipId,'blocked')).status,403);
    assert.equal((await change(adminA,tenantA,adminB.membershipId,'blocked')).status,404);
    assert.equal((await change(adminA,tenantA,scout.membershipId,'deleted')).status,422);
    const foreign = await change(adminB,tenantB,scout.membershipId,'blocked');
    assert.equal(foreign.status,404);

    const login = await send('/login',{method:'POST',
      body:{ email:scout.email,password:scout.password,tenantId:tenantA }});
    assert.equal(login.status,200,JSON.stringify(login.json));
    const liveToken = login.json.token;
    assert.ok(liveToken);
    assert.equal((await send('/me',{token:liveToken,tenant:tenantA})).status,200);
    const suspended = await change(adminA,tenantA,scout.membershipId,'blocked');
    assert.equal(suspended.status,200,JSON.stringify(suspended.json));
    assert.deepEqual({
      id:suspended.json.data.id,tenant_id:suspended.json.data.tenant_id,
      role:suspended.json.data.role_code,status:suspended.json.data.status,
      changed:suspended.json.data.changed
    }, {id:scout.membershipId,tenant_id:tenantA,role:'scout',status:'blocked',changed:true});
    assert.equal((await send('/me',{token:liveToken,tenant:tenantA})).status,401,
      'suspension must invalidate persisted session');
    const blockedLogin = await send('/login',{method:'POST',
      body:{ email:scout.email,password:scout.password,tenantId:tenantA }});
    assert.equal(blockedLogin.status,403);
    const replay = await change(adminA,tenantA,scout.membershipId,'blocked');
    assert.equal(replay.status,200);
    assert.equal(replay.json.data.changed,false);
    const restored = await change(adminA,tenantA,scout.membershipId,'active');
    assert.equal(restored.status,200,JSON.stringify(restored.json));
    assert.equal(restored.json.data.changed,true);
    assert.equal((await send('/me',{token:liveToken,tenant:tenantA})).status,401,
      'reactivation must not resurrect revoked sessions');
    assert.equal((await send('/login',{method:'POST',
      body:{email:scout.email,password:scout.password,tenantId:tenantA}})).status,200);
    assert.equal((await change(adminA,tenantA,scout.membershipId,'active')).json.data.changed,false);

    // Globally blocked account cannot be reactivated through tenant controls.
    await owner.query("UPDATE memberships SET status='blocked' WHERE id=$1",[scout.membershipId]);
    await owner.query("UPDATE users SET status='blocked' WHERE id=$1",[scout.id]);
    const disabled = await change(adminA,tenantA,scout.membershipId,'active');
    assert.equal(disabled.status,409);
    assert.equal(disabled.json.error.code,'MEMBER_USER_BLOCKED');
    await owner.query("UPDATE users SET status='active' WHERE id=$1",[scout.id]);

    // Plan downgrade: future activation must respect the new tenant seat cap.
    const planId = await inserted(
      "INSERT INTO plans(code,name,max_users) VALUES($1,'Tiny lifecycle plan',1) RETURNING id",
      ['lifecycle-cap-' + suffix]);
    const tinyTenant = await inserted(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
      [planId,'Lifecycle capacity','lifecycle-cap-' + suffix]);
    tenants.push(tinyTenant);
    const tinyAdmin = await makeMember(tinyTenant,'admin tiny','tenant_admin');
    const tinyScout = await makeMember(tinyTenant,'scout tiny','scout');
    await owner.query("UPDATE memberships SET status='blocked' WHERE id=$1",[tinyScout.membershipId]);
    const capacity = await change(tinyAdmin,tinyTenant,tinyScout.membershipId,'active');
    assert.equal(capacity.status,409);
    assert.equal(capacity.json.error.code,'MEMBER_SEATS_FULL');

    const audits = (await owner.query(
      "SELECT action,actor_id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 ORDER BY created_at",
      [tenantA,scout.membershipId])).rows;
    assert.deepEqual(audits.map(row=>row.action),['membership.suspended','membership.reactivated']);
    assert.ok(audits.every(row=>row.actor_id===adminA.id));

    await runtime.query('BEGIN');
    try {
      await runtime.query("SELECT set_config('app.current_tenant',$1,true)",[tenantB]);
      assert.deepEqual((await runtime.query(
        'SELECT id FROM memberships WHERE id=$1',[scout.membershipId])).rows,[]);
    } finally { await runtime.query('ROLLBACK'); }
  } finally {
    if(ownerConnected) {
      try {
        if(tenants.length)await owner.query(
          'DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length)await owner.query(
          'DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
        await owner.query('DELETE FROM plans WHERE code=$1',['lifecycle-cap-' + suffix]);
      } finally { await owner.end(); }
    }
    if(runtimeConnected)await runtime.end();
  }
});
