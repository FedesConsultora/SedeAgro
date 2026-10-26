// Disposable PostGIS; prove a globally blocked/deleted user cannot receive
// tenant choices, cookies, JWTs or persisted session receipts despite active
// memberships in TWO companies. Runtime uses the real non-owner DB role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.TEST_DATABASE_ADMIN_URL || !process.env.TEST_DATABASE_APP_URL) {
  throw new Error('loginAccountStatus.pg.mjs requires disposable TEST PostGIS credentials');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'login-global-status-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { hashPassword } = await import('../src/utils/password.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('globally blocked or deleted user has no tenant selection, token, cookie or new session', async t => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  const runtime = new pg.Client({ connectionString: process.env.TEST_DATABASE_APP_URL });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const prefix = 'http://127.0.0.1:' + server.address().port + '/api/v1/auth';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = 'global-login-status-' + suffix + '@example.test';
  const password = 'SedeAgroStatusPass493!';
  let ownerReady = false, runtimeReady = false, userId = null;
  const tenantIds = [];
  const create = async (q,args) => (await admin.query(q,args)).rows[0].id;
  async function postLogin(body, cookie = false) {
    const response = await fetch(prefix + '/login', {
      method: 'POST',
      headers: { 'content-type':'application/json',
        ...(cookie ? { 'x-sedeagro-session': 'cookie' } : {}) },
      body: JSON.stringify(body)
    });
    return { status:response.status, body: await response.json(),
      cookie: response.headers.get('set-cookie') };
  }
  async function me(token, tenant) {
    const response = await fetch(prefix + '/me', {
      headers: { authorization:'Bearer '+token,'x-tenant-id':tenant }
    });
    return response.status;
  }
  const login = {email,password};
  const countSessions = async () => Number((await admin.query(
    'SELECT count(*) AS n FROM auth_sessions WHERE user_id=$1',[userId])).rows[0].n);

  try {
    await admin.connect(); ownerReady = true;
    await runtime.connect(); runtimeReady = true;
    const [{ db }] = (await admin.query('SELECT current_database() AS db')).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    const [{ runtimeDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS "runtimeDb", r.rolname,r.rolsuper,
        r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.equal(runtimeDb,db);
    assert.ok(isSafeRuntimeDbRole(role), 'HTTP DB role must not bypass RLS');

    const plan = (await admin.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan, 'CI fixture requires seeded starter plan');
    for(const tag of ['A','B']){
      const tenantId = await create(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Global login '+tag,'login-status-'+tag.toLowerCase()+'-'+suffix]);
      tenantIds.push(tenantId);
    }
    userId = await create(
      "INSERT INTO users(email,full_name,password_hash,status) VALUES($1,$2,$3,'active') RETURNING id",
      [email,'Globally Scoped User',await hashPassword(password)]
    );
    for(const tenantId of tenantIds){
      await admin.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,'tenant_admin','active')",
        [tenantId,userId]
      );
    }

    // Valid multiempresa behavior must not regress.
    const choices = await postLogin(login);
    assert.equal(choices.status,200,JSON.stringify(choices.body));
    assert.equal(choices.body.requiresTenantSelection,true);
    assert.deepEqual(new Set(choices.body.memberships.map(x=>x.tenantId)),
      new Set(tenantIds));

    const bearer = await postLogin({...login,tenantId:tenantIds[0]});
    assert.equal(bearer.status,200,JSON.stringify(bearer.body));
    assert.ok(typeof bearer.body.token === 'string' && bearer.body.token.length > 20);
    assert.equal(await me(bearer.body.token,tenantIds[0]),200);
    const validCookie = await postLogin({...login,tenantId:tenantIds[1]},true);
    assert.equal(validCookie.status,200);
    assert.ok(validCookie.cookie?.includes('HttpOnly'));
    assert.equal(validCookie.body.token,undefined);
    assert.equal(await countSessions(),2);

    // The global disable does not change memberships: both remain active.
    // No request must reveal tenant names or create a fresh JWT/cookie.
    const invalidPassword = await postLogin({...login,password:'not the password'});
    assert.equal(invalidPassword.status,401);
    for(const state of ['blocked','deleted']){
      await admin.query('UPDATE users SET status=$1 WHERE id=$2',[state,userId]);
      for(const body of [
        login,
        {...login,tenantId:tenantIds[0]},
        {...login,tenantId:tenantIds[1]}
      ]){
        for(const cookie of [false,true]){
          const denied = await postLogin(body,cookie);
          assert.equal(denied.status,401,JSON.stringify(denied.body));
          assert.equal(denied.body.error.message,invalidPassword.body.error.message);
          assert.equal(denied.body.requiresTenantSelection,undefined);
          assert.equal(denied.body.memberships,undefined);
          assert.equal(denied.body.token,undefined);
          assert.equal(denied.cookie,null);
        }
      }
      assert.equal(await countSessions(),2, 'disabled user must not mint any new sessions');
      assert.equal(await me(bearer.body.token,tenantIds[0]),401,
        'requireAuth must also deny existing sessions during global disable');
      const remainingMemberships = Number((await admin.query(
        "SELECT count(*) AS n FROM memberships WHERE user_id=$1 AND status='active'",
        [userId])).rows[0].n);
      assert.equal(remainingMemberships,2);
    }

    await admin.query("UPDATE users SET status='active' WHERE id=$1",[userId]);
    const reopened = await postLogin(login);
    assert.equal(reopened.status,200);
    assert.equal(reopened.body.requiresTenantSelection,true);
    const selected = await postLogin({...login,tenantId:tenantIds[0]});
    assert.equal(selected.status,200,JSON.stringify(selected.body));
    assert.equal(await countSessions(),3);
  } finally {
    if(ownerReady){
      try{
        if(tenantIds.length) await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenantIds]);
        if(userId) await admin.query('DELETE FROM users WHERE id=$1',[userId]);
      } finally { await admin.end(); }
    }
    if(runtimeReady) await runtime.end();
  }
});
