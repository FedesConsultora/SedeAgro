// Pilot acceptance: global suspension is a single HTTP transaction that
// invalidates persisted sessions in EVERY tenant, not only the admin's tenant.
// Disposable seeded PostGIS, authentic nonowner app DB role, real HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.TEST_DATABASE_ADMIN_URL || !process.env.TEST_DATABASE_APP_URL) {
  throw new Error('platformGlobalUserLifecycle.pg.mjs requires disposable TEST DB URLs');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'platform-global-user-status-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { hashPassword } = await import('../src/utils/password.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('platform admin global block revokes all tenant sessions and reactivation never revives old JWT', async t => {
  const owner = new pg.Client({ connectionString:process.env.TEST_DATABASE_ADMIN_URL });
  const runtime = new pg.Client({ connectionString:process.env.TEST_DATABASE_APP_URL });
  const server = createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await sequelize.close();
  });
  const port=server.address().port;
  const base='http://127.0.0.1:'+port+'/api/v1';
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const tenants=[], users=[];
  let readyOwner=false,readyRuntime=false;
  const insert=async(q,args)=>(await owner.query(q,args)).rows[0].id;
  const password='SedeAgroUserLifecycle493!';
  async function request(path,{method='GET',token,tenant,body}={}){
    const response=await fetch(base+path,{
      method,headers:{
        ...(token?{authorization:'Bearer '+token}:{}),
        ...(tenant?{'x-tenant-id':tenant}:{}),
        ...(body?{'content-type':'application/json'}:{})
      },
      ...(body?{body:JSON.stringify(body)}:{})
    });
    const payload=await response.text();
    return {status:response.status,body:payload?JSON.parse(payload):null,
      cache:response.headers.get('cache-control')};
  }
  try {
    await owner.connect();readyOwner=true;
    await runtime.connect();readyRuntime=true;
    const db=(await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i);
    const [{ appDb,...role }]=(await runtime.query(`
      SELECT current_database() AS "appDb",r.rolname,r.rolsuper,r.rolbypassrls,
        r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.equal(appDb,db);assert.ok(isSafeRuntimeDbRole(role));
    const sessionsPolicy=(await owner.query(`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid='public.auth_sessions'::regclass
    `)).rows[0];
    assert.ok(sessionsPolicy.relrowsecurity&&sessionsPolicy.relforcerowsecurity);
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    for(const tag of ['A','B','C']){
      tenants.push(await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Global-user-lifecycle-'+tag,
          'global-user-lifecycle-'+tag.toLowerCase()+'-'+suffix]));
    }
    const [tenantA,tenantB,tenantC]=tenants;
    async function createUser(label,isPlatform){
      const email='global-lifecycle-'+label+'-'+suffix+'@example.test';
      const id=await insert(
        'INSERT INTO users(email,full_name,password_hash,is_platform_admin) VALUES($1,$2,$3,$4) RETURNING id',
        [email,'Lifecycle '+label,await hashPassword(password),isPlatform]);
      users.push(id);return {id,email};
    }
    async function addMembership(userId,tenant,role){
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenant,userId,role]);
    }
    const admin=await createUser('admin',true);
    const target=await createUser('target',false);
    const scout=await createUser('scout',false);
    await addMembership(admin.id,tenantA,'tenant_admin');
    await addMembership(target.id,tenantA,'tenant_admin');
    await addMembership(target.id,tenantB,'tenant_admin');
    await addMembership(target.id,tenantC,'tenant_admin');
    await addMembership(scout.id,tenantA,'scout');
    const adminToken=signSession({sub:admin.id,tenant_id:tenantA,role_code:'tenant_admin'});
    const scoutToken=signSession({sub:scout.id,tenant_id:tenantA,role_code:'scout'});
    const status=(token,id,value)=>request('/platform/users/'+id+'/status',{
      token,tenant:tenantA,method:'PATCH',body:{status:value}});
    const login=(tenant)=>request('/auth/login',{method:'POST',body:{
      email:target.email,password,tenantId:tenant}});
    const authMe=(token,tenant)=>request('/auth/me',{token,tenant});
    const a=await login(tenantA),b=await login(tenantB),c=await login(tenantC);
    assert.equal(a.status,200,JSON.stringify(a.body));
    assert.equal(b.status,200,JSON.stringify(b.body));
    assert.equal(c.status,200,JSON.stringify(c.body));
    assert.equal((await authMe(a.body.token,tenantA)).status,200);
    assert.equal((await authMe(b.body.token,tenantB)).status,200);
    assert.equal((await authMe(c.body.token,tenantC)).status,200);
    // Remove one membership but intentionally retain its persisted AuthSession:
    // old JWT must still be revoked when globally blocking the account.
    await owner.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
      [tenantC,target.id]);
    assert.equal((await authMe(c.body.token,tenantC)).status,401);

    const forbidden=await status(scoutToken,target.id,'blocked');
    assert.equal(forbidden.status,403);
    assert.equal((await status(adminToken,admin.id,'blocked')).status,403,
      'cannot disable self or another platform admin');
    assert.equal((await status(adminToken,target.id,'deleted')).status,422);
    const before=(await owner.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1',
      [target.id])).rows[0].n;
    assert.equal(before,3);

    const blocked=await status(adminToken,target.id,'blocked');
    assert.equal(blocked.status,200,JSON.stringify(blocked.body));
    assert.deepEqual(blocked.body.data,{
      id:target.id,status:'blocked',changed:true,revokedSessions:3
    });
    assert.match(blocked.cache,/no-store/);
    assert.equal((await authMe(a.body.token,tenantA)).status,401);
    assert.equal((await authMe(b.body.token,tenantB)).status,401);
    assert.equal((await authMe(c.body.token,tenantC)).status,401);
    assert.equal((await login(tenantA)).status,401);
    assert.equal((await login(tenantB)).status,401);
    const sessions=(await owner.query(
      'SELECT tenant_id,revoked_at FROM auth_sessions WHERE user_id=$1 ORDER BY tenant_id',
      [target.id])).rows;
    assert.equal(sessions.length,3);
    assert.ok(sessions.every(x=>x.revoked_at));
    assert.deepEqual(new Set(sessions.map(x=>x.tenant_id)),new Set(tenants));

    // A tenant-A runtime principal must not read tenant B's receipt rows.
    await runtime.query('BEGIN');
    try{
      await runtime.query("SELECT set_config('app.current_tenant',$1,true)",[tenantA]);
      const foreign=(await runtime.query(
        'SELECT id FROM auth_sessions WHERE tenant_id=$1 AND user_id=$2',
        [tenantB,target.id])).rows;
      assert.deepEqual(foreign,[]);
    }finally{await runtime.query('ROLLBACK');}

    const twice=await status(adminToken,target.id,'blocked');
    assert.equal(twice.status,200);
    assert.equal(twice.body.data.changed,false);
    assert.equal(twice.body.data.revokedSessions,0);

    const active=await status(adminToken,target.id,'active');
    assert.equal(active.status,200,JSON.stringify(active.body));
    assert.deepEqual(active.body.data,{
      id:target.id,status:'active',changed:true,revokedSessions:0
    });
    assert.equal((await authMe(a.body.token,tenantA)).status,401,
      'previously revoked tenant-A token must not resurrect');
    assert.equal((await authMe(b.body.token,tenantB)).status,401,
      'previously revoked tenant-B token must not resurrect');
    // Re-admission to a *former* tenant is particularly dangerous: the prior
    // JWT must not regain access merely because its membership was recreated.
    await addMembership(target.id,tenantC,'tenant_admin');
    assert.equal((await authMe(c.body.token,tenantC)).status,401,
      'orphan session must stay revoked after the tenant membership returns');
    const fresh=await login(tenantB);
    assert.equal(fresh.status,200,JSON.stringify(fresh.body));
    assert.equal((await authMe(fresh.body.token,tenantB)).status,200);

    const audit=(await owner.query(
      "SELECT action,payload FROM platform_audit_logs WHERE actor_id=$1 AND payload->>'user_id'=$2 ORDER BY created_at",
      [admin.id,target.id])).rows;
    assert.equal(audit.length,2);
    assert.ok(audit.every(x=>x.action==='platform.user.global_status_changed'));
    assert.deepEqual(audit.map(x=>x.payload.next_status),['blocked','active']);
    assert.deepEqual(audit.map(x=>x.payload.revoked_sessions),[3,0]);

    await owner.query("UPDATE users SET status='deleted' WHERE id=$1",[target.id]);
    assert.equal((await status(adminToken,target.id,'active')).status,409,
      'deleted accounts must never be restored by an ordinary status toggle');
  }finally{
    if(readyOwner){
      try{
        if(tenants.length)await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length)await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      }finally{await owner.end();}
    }
    if(readyRuntime)await runtime.end();
  }
});
