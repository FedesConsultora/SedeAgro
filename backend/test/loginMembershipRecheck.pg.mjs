// Real HTTP + disposable PostGIS using the non-owner app runtime. Prove
// that stale login discovery cannot mint a blocked membership or stale role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.TEST_DATABASE_ADMIN_URL || !process.env.TEST_DATABASE_APP_URL) {
  throw new Error('loginMembershipRecheck.pg.mjs requires disposable test DB URLs');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'membership-revalidation-test-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { Membership } = await import('../src/models/index.js');
const { hashPassword } = await import('../src/utils/password.js');
const { verifySession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('login enforces tenant selector agreement and prevents stale membership issuance', async t => {
  const owner = new pg.Client({connectionString:process.env.TEST_DATABASE_ADMIN_URL});
  const appRole = new pg.Client({connectionString:process.env.TEST_DATABASE_APP_URL});
  const server = createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await sequelize.close();});
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/auth';
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const email='membership-check-'+suffix+'@example.test';
  const password='MembershipRecheck2026Secure!';
  const tenantIds=[];
  let userId=null,readyOwner=false,readyApp=false;
  const create = async(sql,params)=>(await owner.query(sql,params)).rows[0].id;
  async function login(select={}, cookie=false) {
    const response=await fetch(url+'/login',{
      method:'POST',headers:{
        'content-type':'application/json',
        ...(cookie?{'x-sedeagro-session':'cookie'}:{})
      },body:JSON.stringify({email,password,...select})
    });
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  const count=async()=>Number((await owner.query(
    'SELECT count(*)::int AS count FROM auth_sessions WHERE user_id=$1',[userId])).rows[0].count);
  try{
    await owner.connect();readyOwner=true;
    await appRole.connect();readyApp=true;
    const db=(await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i);
    const role=(await appRole.query(`
      SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows[0];
    assert.ok(isSafeRuntimeDbRole(role));
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const slugs=['membership-a-'+suffix,'membership-b-'+suffix];
    for(const slug of slugs){
      tenantIds.push(await create("INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Test '+slug,slug]));
    }
    userId=await create("INSERT INTO users(email,full_name,password_hash) VALUES($1,$2,$3) RETURNING id",
      [email,'Membership selector test',await hashPassword(password)]);
    const [tenantA,tenantB]=tenantIds;
    const memA=await create("INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,'tenant_admin','active') RETURNING id",
      [tenantA,userId]);
    await create("INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,'scout','active') RETURNING id",
      [tenantB,userId]);

    const choices=await login();
    assert.equal(choices.status,200,JSON.stringify(choices.body));
    assert.equal(choices.body.requiresTenantSelection,true);
    assert.deepEqual(new Set(choices.body.memberships.map(x=>x.tenantId)),new Set(tenantIds));
    assert.equal(await count(),0, 'tenant discovery must not mint a session');

    for(const bad of [
      {tenantId:tenantA,tenantSlug:slugs[1]},
      {tenantId:tenantB,tenantSlug:slugs[0]},
      {tenantId:tenantA,tenantSlug:'unrelated-'+suffix},
      {tenantId:randomUUID()},
      {tenantSlug:'not-owned-'+suffix}
    ]){
      const denied=await login(bad);
      assert.equal(denied.status,403,JSON.stringify(denied.body));
      assert.equal(denied.body.requiresTenantSelection,undefined);
      assert.equal(denied.body.token,undefined);
      assert.equal(denied.cookie,null);
    }
    assert.equal(await count(),0,'contradictory selectors never mint a JWT');

    const a=await login({tenantId:tenantA,tenantSlug:slugs[0]});
    assert.equal(a.status,200,JSON.stringify(a.body));
    assert.equal(a.body.membership.roleCode,'tenant_admin');
    assert.equal(verifySession(a.body.token).tenant_id,tenantA);
    const b=await login({tenantSlug:slugs[1]},true);
    assert.equal(b.status,200,JSON.stringify(b.body));
    assert.equal(b.body.membership.roleCode,'scout');
    assert.equal(b.body.token,undefined);
    assert.match(b.cookie,/HttpOnly/);
    assert.equal(await count(),2);

    // Inject a deterministic state change AFTER the initial public membership
    // list has returned its Sequelize objects, but BEFORE the tenant-scoped
    // issuance transaction has re-read and locked the chosen row.
    const orig=Membership.findOne;
    let intervened=false;
    Membership.findOne=async function(options) {
      const row=await orig.call(this,options);
      if(!intervened && row && options?.where?.tenant_id===tenantA &&
          options?.where?.user_id===userId && options?.where?.status==='active'){
        intervened=true;
        await owner.query("UPDATE memberships SET status='blocked' WHERE id=$1",[memA]);
      }
      return row;
    };
    let blocked;
    try{blocked=await login({tenantId:tenantA});}
    finally{Membership.findOne=orig;}
    assert.equal(intervened,true,'fixture must cause a precise post-discovery race');
    assert.equal(blocked.status,401,JSON.stringify(blocked.body));
    assert.equal(blocked.body.token,undefined);
    assert.equal(await count(),2,'blocked membership must never issue a new persisted session');

    await owner.query("UPDATE memberships SET status='active',role_code='agronomic_coordinator' WHERE id=$1",[memA]);
    const original2=Membership.findOne;
    let roleChanged=false;
    Membership.findOne=async function(options){
      const row=await original2.call(this,options);
      if(!roleChanged && row && options?.where?.tenant_id===tenantA &&
          options?.where?.user_id===userId && options?.where?.status==='active'){
        roleChanged=true;
        await owner.query("UPDATE memberships SET role_code='scout' WHERE id=$1",[memA]);
      }
      return row;
    };
    let changedRole;
    try{changedRole=await login({tenantId:tenantA});}
    finally{Membership.findOne=original2;}
    assert.equal(roleChanged,true);
    assert.equal(changedRole.status,200,JSON.stringify(changedRole.body));
    assert.equal(changedRole.body.membership.roleCode,'scout');
    assert.equal(verifySession(changedRole.body.token).role_code,'scout');
    assert.equal(await count(),3);
  }finally{
    if(readyOwner){
      try{
        if(tenantIds.length)await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenantIds]);
        if(userId)await owner.query('DELETE FROM users WHERE id=$1',[userId]);
      }finally{await owner.end();}
    }
    if(readyApp)await appRole.end();
  }
});
