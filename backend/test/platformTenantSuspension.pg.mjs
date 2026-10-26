// Real HTTP, non-owner runtime, disposable PostGIS: suspension of a
// tenant must revoke all of its persisted browser/bearer sessions, with FORCE
// RLS still on. Reactivation never resurrects pre-suspension JTIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if(!process.env.TEST_DATABASE_ADMIN_URL||!process.env.TEST_DATABASE_APP_URL)
  throw new Error('platformTenantSuspension.pg.mjs requires disposable TEST URLs');
process.env.DATABASE_URL=process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV='test';
process.env.JWT_SECRET='tenant-suspension-ci-only';

const {createApp}=await import('../src/app.js');
const {sequelize}=await import('../src/core/db.js');
const {hashPassword}=await import('../src/utils/password.js');
const {isSafeRuntimeDbRole}=await import('../src/core/tenantDbSafety.js');

test('platform tenant suspension invalidates all JTIs and blocks token revival',async t=>{
  const owner=new pg.Client({connectionString:process.env.TEST_DATABASE_ADMIN_URL});
  const runtime=new pg.Client({connectionString:process.env.TEST_DATABASE_APP_URL});
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await sequelize.close();
  });
  const base='http://127.0.0.1:'+server.address().port+'/api/v1';
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const password='TenantSuspendSecure2026Pass!';
  const tenants=[],users=[];
  let connectedOwner=false,connectedRuntime=false;
  const insert=async(sql,args)=>(await owner.query(sql,args)).rows[0].id;
  async function send(path,{method='GET',tenant,token,cookie=false,body}={}){
    const response=await fetch(base+path,{
      method,headers:{
        ...(token?{authorization:'Bearer '+token}:{}),
        ...(tenant?{'x-tenant-id':tenant}:{}),
        ...(cookie?{'x-sedeagro-session':'cookie'}:{}),
        ...(body?{'content-type':'application/json'}:{})
      },
      ...(body?{body:JSON.stringify(body)}:{})
    });
    const raw=await response.text();
    return {status:response.status,body:raw?JSON.parse(raw):null,
      cookie:response.headers.get('set-cookie')};
  }
  try{
    await owner.connect();connectedOwner=true;
    await runtime.connect();connectedRuntime=true;
    const db=(await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i);
    const role=(await runtime.query(`
      SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows[0];
    assert.ok(isSafeRuntimeDbRole(role));
    const policy=(await owner.query(`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid='public.auth_sessions'::regclass
    `)).rows[0];
    assert.ok(policy.relrowsecurity&&policy.relforcerowsecurity);

    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const extra=await insert(
      'INSERT INTO plans(code,name,max_users) VALUES($1,$2,10) RETURNING id',
      ['tenant-suspend-plan-'+suffix,'Separate plan for status test']);
    const names=['home-'+suffix,'target-'+suffix];
    for(const slug of names){
      tenants.push(await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Tenant '+slug,'tenant-suspend-'+slug]));
    }
    const [home,target]=tenants;
    async function makeUser(label,tenant,roleCode,isPlatform){
      const email='suspend-'+label+'-'+suffix+'@example.test';
      const id=await insert('INSERT INTO users(email,full_name,password_hash,is_platform_admin) VALUES($1,$2,$3,$4) RETURNING id',
        [email,'User '+label,await hashPassword(password),isPlatform]);
      users.push(id);
      await owner.query("INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenant,id,roleCode]);
      return {id,email,tenant};
    }
    const operator=await makeUser('operator',home,'tenant_admin',true);
    const worker=await makeUser('worker',target,'tenant_admin',false);
    const scout=await makeUser('scout',home,'scout',false);
    const login=async who=>send('/auth/login',{method:'POST',body:{
      email:who.email,password,tenantId:who.tenant
    }});
    const admin=await login(operator),staff=await login(worker),scoutLogin=await login(scout);
    for(const x of [admin,staff,scoutLogin])assert.equal(x.status,200,JSON.stringify(x.body));
    const secondWorker=await login(worker);
    assert.equal(secondWorker.status,200);
    const browserWorker=await send('/auth/login',{method:'POST',cookie:true,
      body:{email:worker.email,password,tenantId:target}});
    assert.equal(browserWorker.status,200);
    assert.match(browserWorker.cookie,/HttpOnly/);
    const tokenA=admin.body.token,tokenB=staff.body.token;
    const otherB=secondWorker.body.token;
    assert.equal((await send('/auth/me',{tenant:target,token:tokenB})).status,200);
    const modify=(token,id,body)=>send('/platform/tenants/'+id,{
      method:'PATCH',tenant:home,token,body
    });
    const unauthorized=await modify(scoutLogin.body.token,target,{status:'suspended'});
    assert.equal(unauthorized.status,403);
    const self=await modify(tokenA,home,{status:'suspended'});
    assert.equal(self.status,409);

    // Plan-only update must preserve all tenant sessions.
    const planChanged=await modify(tokenA,target,{plan_id:extra});
    assert.equal(planChanged.status,200,JSON.stringify(planChanged.body));
    assert.equal(planChanged.body.revokedSessions,0);
    assert.equal((await send('/auth/me',{tenant:target,token:tokenB})).status,200);
    const before=(await owner.query(
      'SELECT count(*)::int AS n FROM auth_sessions WHERE tenant_id=$1 AND revoked_at IS NULL',
      [target])).rows[0].n;
    assert.equal(before,3,'bearer + bearer + cookie sessions exist');

    const blocked=await modify(tokenA,target,{status:'suspended'});
    assert.equal(blocked.status,200,JSON.stringify(blocked.body));
    assert.equal(blocked.body.revokedSessions,3);
    assert.equal(blocked.body.changed,true);
    assert.equal(blocked.body.data.status,'suspended');
    assert.equal((await send('/auth/me',{tenant:target,token:tokenB})).status,403,
      'tenant resolver denies suspended tenant even before checking token');

    const rows=(await owner.query(
      'SELECT revoked_at FROM auth_sessions WHERE tenant_id=$1',[target])).rows;
    assert.equal(rows.length,3);
    assert.ok(rows.every(row=>row.revoked_at));
    // Nonowner scope of the operator's home tenant cannot read target sessions.
    await runtime.query('BEGIN');
    try{
      await runtime.query("SELECT set_config('app.current_tenant',$1,true)",[home]);
      assert.deepEqual((await runtime.query(
        'SELECT id FROM auth_sessions WHERE tenant_id=$1',[target])).rows,[]);
    }finally{await runtime.query('ROLLBACK');}

    const repeat=await modify(tokenA,target,{status:'suspended'});
    assert.equal(repeat.status,200);
    assert.equal(repeat.body.changed,false);
    assert.equal(repeat.body.revokedSessions,0);

    const restore=await modify(tokenA,target,{status:'active'});
    assert.equal(restore.status,200,JSON.stringify(restore.body));
    assert.equal(restore.body.revokedSessions,0);
    assert.equal((await send('/auth/me',{tenant:target,token:tokenB})).status,401);
    assert.equal((await send('/auth/me',{tenant:target,token:otherB})).status,401);
    const afterBrowser=await fetch(base+'/auth/me',{
      headers:{cookie:browserWorker.cookie.split(';')[0],'x-tenant-id':target}
    });
    assert.equal(afterBrowser.status,401);
    const fresh=await login(worker);
    assert.equal(fresh.status,200,JSON.stringify(fresh.body));
    assert.equal((await send('/auth/me',{tenant:target,token:fresh.body.token})).status,200);
    assert.equal((await send('/auth/me',{tenant:home,token:tokenA})).status,200,
      'operation cannot leak target GUC into caller session');
    const audits=(await owner.query(
      "SELECT action,payload FROM platform_audit_logs WHERE tenant_id=$1 AND action='platform.tenant.lifecycle_updated' ORDER BY created_at",
      [target])).rows;
    assert.equal(audits.length,3,'plan change, suspend, restore');
    assert.deepEqual(audits.map(x=>x.payload.revoked_sessions),[0,3,0]);

    const deleted=await modify(tokenA,target,{status:'deleted'});
    assert.equal(deleted.status,200);
    assert.equal(deleted.body.revokedSessions,1);
    const forbiddenRestore=await modify(tokenA,target,{status:'active'});
    assert.equal(forbiddenRestore.status,409);
    assert.equal((await owner.query('SELECT status FROM tenants WHERE id=$1',[target])).rows[0].status,'deleted');
  }finally{
    if(connectedOwner){
      try{
        if(tenants.length)await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length)await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
        await owner.query('DELETE FROM plans WHERE code=$1',['tenant-suspend-plan-'+suffix]);
      }finally{await owner.end();}
    }
    if(connectedRuntime)await runtime.end();
  }
});
