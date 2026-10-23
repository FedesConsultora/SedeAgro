// 0U.13 — calendar chronology on campaign and campaign-field POST/PATCH.
// Disposable migrated/seeded PostGIS *_test, non-owner app role with FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl=process.env.TEST_DATABASE_ADMIN_URL;
const appUrl=process.env.TEST_DATABASE_APP_URL;
if(!adminUrl||!appUrl) throw new Error('campaignDateIntegrity needs disposable *_test DB URLs');
process.env.DATABASE_URL=appUrl;
process.env.NODE_ENV='test';
process.env.JWT_SECRET='campaign-date-integrity-ci-only';
const {createApp}=await import('../src/app.js');
const {sequelize}=await import('../src/core/db.js');
const {signSession}=await import('../src/utils/jwt.js');
const {isSafeRuntimeDbRole}=await import('../src/core/tenantDbSafety.js');

test('campaign and field date ranges remain chronologically valid across partial updates',async t=>{
  const admin=new pg.Client({connectionString:adminUrl});
  const runtime=new pg.Client({connectionString:appUrl});
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await sequelize.close();
  });
  const base=`http://127.0.0.1:${server.address().port}/api/v1/campaigns`;
  const salt=randomUUID().replaceAll('-','').slice(0,12);
  const tenants=[],users=[];
  let connectedAdmin=false,connectedRuntime=false;
  const insert=async(q,args)=>(await admin.query(q,args)).rows[0].id;
  async function request(path,token,tenantId,method='POST',data){
    const response=await fetch(base+path,{
      method,
      headers:{authorization:`Bearer ${token}`,'x-tenant-id':tenantId,
        ...(data===undefined?{}:{'content-type':'application/json'})},
      ...(data===undefined?{}:{body:JSON.stringify(data)})
    });
    return {status:response.status,json:await response.json()};
  }
  try {
    await admin.connect();connectedAdmin=true;
    await runtime.connect();connectedRuntime=true;
    const [{db}]=(await admin.query('SELECT current_database() AS db')).rows;
    const [{app_db,...role}]=(await runtime.query(`
      SELECT current_database() AS app_db,r.rolname,r.rolsuper,r.rolbypassrls,
        r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(app_db,db);
    assert.ok(isSafeRuntimeDbRole(role),'non-owner RLS API role required');
    const policies=(await admin.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.campaigns'::regclass,'public.campaign_fields'::regclass])
    `)).rows;
    assert.equal(policies.length,2);
    for(const row of policies) assert.ok(row.relrowsecurity&&row.relforcerowsecurity,row.relname);
    const plan=(await admin.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const crop=(await admin.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    assert.ok(plan&&crop,'CI global seed required');
    const tenantA=await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Campaign temporal A',$2,'active') RETURNING id",
      [plan.id,`campaign-time-a-${salt}`]);tenants.push(tenantA);
    const tenantB=await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Campaign temporal B',$2,'active') RETURNING id",
      [plan.id,`campaign-time-b-${salt}`]);tenants.push(tenantB);
    async function member(tid,label,roleCode){
      const id=await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label,`campaign-time-${salt}-${label.replaceAll(' ','-')}@example.test`]);
      users.push(id);
      await admin.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid,id,roleCode]);
      return signSession({sub:id,role_code:roleCode,tenant_id:tid});
    }
    const ownerA=await member(tenantA,'admin a','tenant_admin');
    const coordinatorA=await member(tenantA,'coordinator a','agronomic_coordinator');
    const scoutA=await member(tenantA,'scout a','scout');
    const ownerB=await member(tenantB,'admin b','tenant_admin');
    await admin.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES"+
      "($1,'campaigns',true,'plan'),($2,'campaigns',true,'plan')",[tenantA,tenantB]);
    const farmId=await insert(
      'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantA,`Campaign farm ${salt}`]);
    const fieldId=await insert(
      'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
      [tenantA,farmId,`Campaign field ${salt}`]);

    const name=`Chronological crop plan ${salt}`;
    const input={name,season_year:2026,starts_at:'2026-10-01',ends_at:'2026-11-01'};
    const badCreate=await request('',ownerA,tenantA,'POST',{
      ...input,ends_at:'2026-09-30'});
    assert.equal(badCreate.status,422,JSON.stringify(badCreate.json));
    assert.equal(badCreate.json.error.code,'VALIDATION_ERROR');
    assert.ok(badCreate.json.error.details.fieldErrors.ends_at.length>0);
    const unauthorized=await request('',scoutA,tenantA,'POST',input);
    assert.equal(unauthorized.status,403,JSON.stringify(unauthorized.json));

    const created=await request('',ownerA,tenantA,'POST',input);
    assert.equal(created.status,201,JSON.stringify(created.json));
    const campaignId=created.json.data.id;
    const noEnd=await request('',ownerB,tenantB,'POST',{
      name:`Foreign season ${salt}`,season_year:2026,starts_at:'2026-10-01'});
    assert.equal(noEnd.status,201,JSON.stringify(noEnd.json));

    const tooEarlyEnd=await request(`/${campaignId}`,coordinatorA,tenantA,'PATCH',
      {ends_at:'2026-09-30'});
    assert.equal(tooEarlyEnd.status,422,JSON.stringify(tooEarlyEnd.json));
    assert.equal(tooEarlyEnd.json.error.code,'VALIDATION_ERROR');
    const tooLateStart=await request(`/${campaignId}`,ownerA,tenantA,'PATCH',
      {starts_at:'2026-11-02'});
    assert.equal(tooLateStart.status,422,JSON.stringify(tooLateStart.json));
    const endBoundary=await request(`/${campaignId}`,ownerA,tenantA,'PATCH',
      {ends_at:'2026-10-01'});
    assert.equal(endBoundary.status,200,JSON.stringify(endBoundary.json));
    const updateEnd=await request(`/${campaignId}`,ownerA,tenantA,'PATCH',
      {ends_at:'2026-12-01'});
    assert.equal(updateEnd.status,200,JSON.stringify(updateEnd.json));

    const fieldPath=`/${campaignId}/fields`;
    const cfInput={
      field_id:fieldId,crop_type_id:crop.id,
      planting_date:'2026-10-20',harvest_target_date:'2026-11-20'
    };
    const badField=await request(fieldPath,ownerA,tenantA,'POST',{
      ...cfInput,harvest_target_date:'2026-10-19'});
    assert.equal(badField.status,422,JSON.stringify(badField.json));
    assert.equal(badField.json.error.code,'VALIDATION_ERROR');
    assert.ok(badField.json.error.details.fieldErrors.harvest_target_date.length>0);
    const goodField=await request(fieldPath,coordinatorA,tenantA,'POST',cfInput);
    assert.equal(goodField.status,201,JSON.stringify(goodField.json));
    const cfId=goodField.json.data.id;
    const cfPath=`/${campaignId}/fields/${cfId}`;

    const earlyHarvest=await request(cfPath,ownerA,tenantA,'PATCH',
      {harvest_target_date:'2026-10-19'});
    assert.equal(earlyHarvest.status,422,JSON.stringify(earlyHarvest.json));
    const latePlanting=await request(cfPath,coordinatorA,tenantA,'PATCH',
      {planting_date:'2026-11-21'});
    assert.equal(latePlanting.status,422,JSON.stringify(latePlanting.json));
    const equality=await request(cfPath,ownerA,tenantA,'PATCH',
      {harvest_target_date:'2026-10-20'});
    assert.equal(equality.status,200,JSON.stringify(equality.json));
    const validPatch=await request(cfPath,ownerA,tenantA,'PATCH',
      {harvest_target_date:'2026-12-15'});
    assert.equal(validPatch.status,200,JSON.stringify(validPatch.json));

    const campaigns=(await admin.query(
      `SELECT id,to_char(starts_at,'YYYY-MM-DD') AS starts_at,to_char(ends_at,'YYYY-MM-DD') AS ends_at FROM campaigns WHERE tenant_id=$1`,[tenantA])).rows;
    assert.equal(campaigns.length,1);
    assert.equal(campaigns[0].id,campaignId);
    assert.equal(String(campaigns[0].starts_at).slice(0,10),'2026-10-01');
    assert.equal(String(campaigns[0].ends_at).slice(0,10),'2026-12-01');
    const fields=(await admin.query(
      `SELECT id,to_char(planting_date,'YYYY-MM-DD') AS planting_date,to_char(harvest_target_date,'YYYY-MM-DD') AS harvest_target_date FROM campaign_fields WHERE tenant_id=$1`,
      [tenantA])).rows;
    assert.equal(fields.length,1);
    assert.equal(fields[0].id,cfId);
    assert.equal(String(fields[0].planting_date).slice(0,10),'2026-10-20');
    assert.equal(String(fields[0].harvest_target_date).slice(0,10),'2026-12-15');
    assert.equal((await admin.query(
      'SELECT count(*)::int AS n FROM campaign_fields WHERE tenant_id=$1',[tenantB])).rows[0].n,0);
  } finally {
    if(connectedAdmin){
      try{
        if(tenants.length) await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length) await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      } finally {await admin.end();}
    }
    if(connectedRuntime) await runtime.end();
  }
});
