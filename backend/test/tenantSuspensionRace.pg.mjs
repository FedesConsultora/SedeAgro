// Reproduce two REAL platform-vs-field races under non-owner PostGIS.
// Case A: stale tenantResolver selected B, then platform suspended B.
// Case B: in-flight B business request holds SHARED advisory scope while
// platform suspension requests the corresponding EXCLUSIVE lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if(!process.env.TEST_DATABASE_ADMIN_URL || !process.env.TEST_DATABASE_APP_URL) {
  throw new Error('tenantSuspensionRace.pg.mjs requires disposable TEST PostGIS URLs');
}
process.env.DATABASE_URL=process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV='test';
process.env.JWT_SECRET='tenant-request-fence-disposable-test';

const {createApp}=await import('../src/app.js');
const {sequelize}=await import('../src/core/db.js');
const {AuthSession,Tenant}=await import('../src/models/index.js');
const {hashPassword}=await import('../src/utils/password.js');
const {isSafeRuntimeDbRole}=await import('../src/core/tenantDbSafety.js');

test('stale tenant resolution fails; in-flight request fences platform suspension',async t=>{
  const owner=new pg.Client({connectionString:process.env.TEST_DATABASE_ADMIN_URL});
  const appRole=new pg.Client({connectionString:process.env.TEST_DATABASE_APP_URL});
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await sequelize.close();
  });
  const url='http://127.0.0.1:'+server.address().port+'/api/v1';
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const password='TenantFencePilotSecure2026!';
  const tenants=[],users=[];
  let ownerReady=false,appReady=false;
  const create=async(q,args)=>(await owner.query(q,args)).rows[0].id;
  async function call(path,{method='GET',token,tenant,body}={}){
    const response=await fetch(url+path,{method,headers:{
      ...(token?{authorization:'Bearer '+token}:{}),
      ...(tenant?{'x-tenant-id':tenant}:{}),
      ...(body?{'content-type':'application/json'}:{})
    },...(body?{body:JSON.stringify(body)}:{})});
    const text=await response.text();
    return {status:response.status,body:text?JSON.parse(text):null};
  }
  async function addUser(label,tenant,platform=false) {
    const email='tenant-fence-'+label+'-'+suffix+'@example.test';
    const id=await create(
      'INSERT INTO users(email,full_name,password_hash,is_platform_admin) VALUES($1,$2,$3,$4) RETURNING id',
      [email,'Tenant Fence '+label,await hashPassword(password),platform]
    );
    users.push(id);
    await owner.query(
      "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,'tenant_admin','active')",
      [tenant,id]);
    return {id,email,tenant};
  }
  const login=who=>call('/auth/login',{method:'POST',
    body:{email:who.email,password,tenantId:who.tenant}});
  try {
    await owner.connect();ownerReady=true;
    await appRole.connect();appReady=true;
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
    for(const tag of ['home','target']){
      tenants.push(await create(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Tenant Fence '+tag,'tenant-fence-'+tag+'-'+suffix]));
    }
    const [home,target]=tenants;
    const admin=await addUser('admin',home,true);
    const worker=await addUser('worker',target,false);
    const adminLogin=await login(admin),workerLogin=await login(worker);
    assert.equal(adminLogin.status,200,JSON.stringify(adminLogin.body));
    assert.equal(workerLogin.status,200,JSON.stringify(workerLogin.body));
    const operator=adminLogin.body.token;
    const patch=status=>call('/platform/tenants/'+target,{method:'PATCH',
      tenant:home,token:operator,body:{status}});
    const me=token=>call('/auth/me',{tenant:target,token});
    assert.equal((await me(workerLogin.body.token)).status,200);

    // A: tenantResolver sees an active tenant, but privileged platform
    // suspension commits BEFORE the scoped tenant transaction can begin.
    const originalTenantFind=Tenant.findOne;
    let injected=false;
    Tenant.findOne=async function(options){
      const row=await originalTenantFind.call(this,options);
      if(!injected && !options?.transaction && options?.where?.id===target) {
        injected=true;
        assert.equal(row?.status,'active');
        const blocked=await patch('suspended');
        assert.equal(blocked.status,200,JSON.stringify(blocked.body));
        assert.equal(blocked.body.revokedSessions,1);
      }
      return row;
    };
    let stale;
    try{stale=await me(workerLogin.body.token);}
    finally{Tenant.findOne=originalTenantFind;}
    assert.equal(injected,true,'must suspend after unguarded resolver SELECT');
    assert.equal(stale.status,403,JSON.stringify(stale.body));
    assert.equal(stale.body.error.code,'TENANT_DISABLED_DURING_REQUEST');
    const revoked=(await owner.query(
      'SELECT revoked_at FROM auth_sessions WHERE tenant_id=$1',[target])).rows;
    assert.ok(revoked.every(x=>x.revoked_at));

    assert.equal((await patch('active')).status,200);
    const fresh=await login(worker);
    assert.equal(fresh.status,200,JSON.stringify(fresh.body));
    assert.equal((await me(fresh.body.token)).status,200);

    // B: keep a scoped auth/me request paused AFTER tenantTransaction has
    // acquired SHARED lock but before AuthSession lookup executes.
    const originalFind=AuthSession.findOne;
    let entered;
    const atAuth=new Promise(resolve=>{entered=resolve;});
    let release;
    const openGate=new Promise(resolve=>{release=resolve;});
    let paused=false;
    AuthSession.findOne=async function(options){
      if(!paused && options?.where?.user_id===worker.id &&
          options?.where?.tenant_id===target) {
        paused=true;
        entered();
        await openGate;
      }
      return originalFind.call(this,options);
    };
    let inFlight, suspended;
    try{
      inFlight=me(fresh.body.token);
      await atAuth;
      assert.equal(paused,true);

      // A separate connection must be UNABLE to obtain EXCLUSIVE lifecycle
      // lock while B's authenticated request holds SHARED. No sleep/poll.
      await owner.query('BEGIN');
      try {
        const [{ acquired }]=(await owner.query(
          "SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS acquired",
          ['sedeagro-pilot-tenant-status-v1',target])).rows;
        assert.equal(acquired,false,'in-flight scoped request MUST hold its shared fence');
      }finally{await owner.query('ROLLBACK');}

      suspended=patch('suspended');
    }finally{
      release?.();
      AuthSession.findOne=originalFind;
    }
    const [during,blocked]=await Promise.all([inFlight,suspended]);
    assert.equal(during.status,200,JSON.stringify(during.body));
    assert.equal(blocked.status,200,JSON.stringify(blocked.body));
    assert.equal(blocked.body.revokedSessions,1,
      'platform disable must revoke JTI that was valid before it acquired exclusive lock');
    assert.equal((await me(fresh.body.token)).status,403);
    assert.equal((await patch('active')).status,200);
    assert.equal((await me(fresh.body.token)).status,401,
      'previous token cannot resurrect when tenant becomes active again');
    const lastLogin=await login(worker);
    assert.equal(lastLogin.status,200,JSON.stringify(lastLogin.body));
    assert.equal((await me(lastLogin.body.token)).status,200);
    const events=(await owner.query(
      "SELECT action FROM platform_audit_logs WHERE tenant_id=$1 AND action='platform.tenant.lifecycle_updated'",
      [target])).rows;
    assert.equal(events.length,4,'two platform suspensions and two restorations audited');
  }finally{
    if(ownerReady){
      try{
        if(tenants.length)await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length)await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      }finally{await owner.end();}
    }
    if(appReady)await appRole.end();
  }
});
