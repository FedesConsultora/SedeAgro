// Deterministic real HTTP/PostGIS race: the public login tenant choice sees
// an active company, then platform admin suspends it before issuing a JWT.
// The locked tenant read must reject stale discovery with no token/session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.TEST_DATABASE_ADMIN_URL || !process.env.TEST_DATABASE_APP_URL) {
  throw new Error('loginTenantStatusRace.pg.mjs requires disposable TEST PostGIS URLs');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'login-tenant-lock-race-disposable-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { Membership } = await import('../src/models/index.js');
const { hashPassword } = await import('../src/utils/password.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('suspension after public login discovery cannot mint a resurrectable tenant session', async t => {
  const owner = new pg.Client({ connectionString:process.env.TEST_DATABASE_ADMIN_URL });
  const runtime = new pg.Client({ connectionString:process.env.TEST_DATABASE_APP_URL });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const suffix = randomUUID().replaceAll('-','').slice(0,12);
  const password = 'TenantSuspensionRace2026!';
  const ids = { tenants:[], users:[] };
  let ownerReady=false, runtimeReady=false;
  async function call(path, {method='GET',token,tenant,cookie=false,body}={}) {
    const response=await fetch(base+path,{
      method,headers:{
        ...(token ? {authorization:'Bearer '+token} : {}),
        ...(tenant ? {'x-tenant-id':tenant} : {}),
        ...(cookie ? {'x-sedeagro-session':'cookie'} : {}),
        ...(body ? {'content-type':'application/json'} : {})
      },
      ...(body ? {body:JSON.stringify(body)} : {})
    });
    const json = await response.text();
    return {status:response.status,body:json?JSON.parse(json):null,
      setCookie:response.headers.get('set-cookie')};
  }
  const insert = async(sql,params) => (await owner.query(sql,params)).rows[0].id;
  async function addUser(label, tenant, platform=false) {
    const email='login-race-'+label+'-'+suffix+'@example.test';
    const id=await insert(
      'INSERT INTO users(email,full_name,password_hash,is_platform_admin) VALUES($1,$2,$3,$4) RETURNING id',
      [email,'Login Race '+label,await hashPassword(password),platform]
    );
    ids.users.push(id);
    await owner.query(
      "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,'tenant_admin','active')",
      [tenant,id]
    );
    return {id,email,tenant};
  }
  const login = (who, cookie=false) => call('/auth/login',{
    method:'POST',cookie,body:{email:who.email,password,tenantId:who.tenant}
  });
  try {
    await owner.connect();ownerReady=true;
    await runtime.connect();runtimeReady=true;
    const db=(await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i);
    const role=(await runtime.query(`
      SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
      pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows[0];
    assert.ok(isSafeRuntimeDbRole(role));
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    for(const label of ['home','target']) {
      ids.tenants.push(await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Login Race '+label,'login-race-'+label+'-'+suffix]
      ));
    }
    const [home,target]=ids.tenants;
    const platformAdmin=await addUser('platform-admin',home,true);
    const worker=await addUser('worker',target,false);
    const operator=await login(platformAdmin);
    assert.equal(operator.status,200,JSON.stringify(operator.body));
    const adminToken=operator.body.token;
    const sessionCount=async()=>Number((await owner.query(
      'SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1',
      [worker.id])).rows[0].n);
    assert.equal(await sessionCount(),0);

    // Instrument only the initial global listing for this exact worker; after
    // the Sequelize SELECT has returned active membership + tenant, perform an
    // actual platform suspension as another HTTP transaction. No fixed sleeps,
    // timers or reliance on network scheduling.
    const original=Membership.findAll;
    let intervened=false;
    Membership.findAll=async function(options) {
      const rows=await original.call(this,options);
      if(!intervened && options?.where?.user_id===worker.id &&
          options?.where?.status==='active') {
        intervened=true;
        assert.ok(rows.some(m=>m.tenant_id===target&&m.Tenant.status==='active'));
        const suspended=await call('/platform/tenants/'+target,{
          method:'PATCH',token:adminToken,tenant:home,
          body:{status:'suspended'}
        });
        assert.equal(suspended.status,200,JSON.stringify(suspended.body));
        assert.equal(suspended.body.revokedSessions,0,
          'fixture suspends before any worker session is issued');
      }
      return rows;
    };
    let staleLogin;
    try { staleLogin=await login(worker,true); }
    finally { Membership.findAll=original; }
    assert.equal(intervened,true);
    assert.equal(staleLogin.status,403,JSON.stringify(staleLogin.body));
    assert.equal(staleLogin.body.token,undefined);
    assert.equal(staleLogin.setCookie,null);
    assert.equal(await sessionCount(),0,
      'login cannot mint JTI after platform already revoked all tenant sessions');

    // Restoring company status never makes the rejected login usable.
    const restored=await call('/platform/tenants/'+target,{
      method:'PATCH',token:adminToken,tenant:home,body:{status:'active'}
    });
    assert.equal(restored.status,200,JSON.stringify(restored.body));
    assert.equal(await sessionCount(),0);

    const valid=await login(worker);
    assert.equal(valid.status,200,JSON.stringify(valid.body));
    assert.equal(valid.body.tenant.id,target);
    assert.equal((await call('/auth/me',{tenant:target,token:valid.body.token})).status,200);
    assert.equal(await sessionCount(),1);
    assert.equal((await call('/auth/me',{tenant:home,token:adminToken})).status,200);
    const events=(await owner.query(
      "SELECT action FROM platform_audit_logs WHERE tenant_id=$1 AND action='platform.tenant.lifecycle_updated'",
      [target])).rows;
    assert.equal(events.length,2,'suspension and restoration both leave target-scope audit evidence');
  } finally {
    Membership.findAll = Membership.findAll; // no mocked method survives try/finally above
    if(ownerReady) {
      try {
        if(ids.tenants.length) await owner.query(
          'DELETE FROM tenants WHERE id=ANY($1::uuid[])',[ids.tenants]);
        if(ids.users.length) await owner.query(
          'DELETE FROM users WHERE id=ANY($1::uuid[])',[ids.users]);
      } finally { await owner.end(); }
    }
    if(runtimeReady) await runtime.end();
  }
});
