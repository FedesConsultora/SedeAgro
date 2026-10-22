// 0U.8: team farm scope and duplicate create retry against real PostGIS, FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl=process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl=process.env.TEST_DATABASE_APP_URL;
if(!ownerUrl||!runtimeUrl) throw new Error('teamFarmCreation needs disposable *_test PostgreSQL URLs');
process.env.DATABASE_URL=runtimeUrl;
process.env.NODE_ENV='test';
process.env.JWT_SECRET='team-farm-test-only';
const {createApp}=await import('../src/app.js');
const {sequelize}=await import('../src/core/db.js');
const {signSession}=await import('../src/utils/jwt.js');
const {isSafeRuntimeDbRole}=await import('../src/core/tenantDbSafety.js');

test('team creation validates same-tenant farm and retries without reparenting or duplication',async t=>{
  const owner=new pg.Client({connectionString:ownerUrl});
  const appDb=new pg.Client({connectionString:runtimeUrl});
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await sequelize.close();
  });
  const url=`http://127.0.0.1:${server.address().port}/api/v1/teams`;
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const tenants=[],users=[];
  let ownerConnected=false,appConnected=false;
  const insert=async(sql,values)=>(await owner.query(sql,values)).rows[0].id;
  async function post(token,tenant,data) {
    const response=await fetch(url,{
      method:'POST',headers:{authorization:`Bearer ${token}`,'x-tenant-id':tenant,'content-type':'application/json'},
      body:JSON.stringify(data)
    });
    return {status:response.status,body:await response.json()};
  }
  try {
    await owner.connect();ownerConnected=true;
    await appDb.connect();appConnected=true;
    const [{db}]=(await owner.query('SELECT current_database() AS db')).rows;
    const [{runtime,...role}]=(await appDb.query(`
      SELECT current_database() AS runtime,r.rolname,r.rolsuper,r.rolbypassrls,
        r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user
    `)).rows;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i,'must use test DB');
    assert.equal(runtime,db);
    assert.ok(isSafeRuntimeDbRole(role),'runtime non-owner RLS required');
    const tables=(await owner.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.teams'::regclass,'public.farms'::regclass])
    `)).rows;
    assert.equal(tables.length,2);
    for(const table of tables) assert.ok(table.relrowsecurity&&table.relforcerowsecurity,table.relname);
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const a=await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Team farm A',$2,'active') RETURNING id",
      [plan.id,`team-farm-a-${suffix}`]);tenants.push(a);
    const b=await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Team farm B',$2,'active') RETURNING id",
      [plan.id,`team-farm-b-${suffix}`]);tenants.push(b);
    async function user(tid,label,roleCode){
      const id=await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label,`team-farm-${suffix}-${label.replaceAll(' ','-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid,id,roleCode]);
      return signSession({sub:id,role_code:roleCode,tenant_id:tid});
    }
    const adminA=await user(a,'admin a','tenant_admin');
    const coordA=await user(a,'coordinator a','agronomic_coordinator');
    const scoutA=await user(a,'scout a','scout');
    const adminB=await user(b,'admin b','tenant_admin');
    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES"+
      "($1,'org',true,'plan'),($2,'org',true,'plan')",[a,b]);
    const farmA=await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [a,`farm A ${suffix}`]);
    const farmB=await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [b,`farm B ${suffix}`]);
    const name=`Team field ops ${suffix}`;
    const team={name,scope:'field_ops',farm_id:farmA,notes:'Visit farms'};
    const created=await post(adminA,a,team);
    assert.equal(created.status,201,JSON.stringify(created.body));
    const teamId=created.body.data.id;
    assert.equal(created.body.data.farm_id,farmA);
    const retry=await post(adminA,a,team);
    assert.equal(retry.status,200,JSON.stringify(retry.body));
    assert.equal(retry.body.data.id,teamId);
    assert.equal(retry.body.replayed,true);

    for(const patch of [
      {...team,farm_id:null},
      {...team,farm_id:farmB},
      {...team,scope:'support'},
      {...team,notes:'Different plan'}
    ]) {
      const res=await post(adminA,a,patch);
      if(patch.farm_id===farmB) {
        assert.equal(res.status,404,JSON.stringify(res.body));
        assert.equal(res.body.error.code,'TEAM_FARM_NOT_FOUND');
      } else {
        assert.equal(res.status,409,JSON.stringify(res.body));
        assert.equal(res.body.error.code,'TEAM_CREATE_CONFLICT');
      }
    }
    const absent=await post(adminA,a,{name:`Missing ${suffix}`,farm_id:randomUUID()});
    assert.equal(absent.status,404,JSON.stringify(absent.body));
    const foreign=await post(adminA,a,{name:`Foreign ${suffix}`,farm_id:farmB});
    assert.equal(foreign.status,404,JSON.stringify(foreign.body));
    const noFarm=await post(coordA,a,{name:`No farm ${suffix}`});
    assert.equal(noFarm.status,201,JSON.stringify(noFarm.body));
    assert.equal(noFarm.body.data.farm_id,null);
    const noFarmReplay=await post(coordA,a,{name:`No farm ${suffix}`,scope:'field_ops',farm_id:null});
    assert.equal(noFarmReplay.status,200,JSON.stringify(noFarmReplay.body));
    assert.equal(noFarmReplay.body.data.id,noFarm.body.data.id);
    const denied=await post(scoutA,a,{name:`Denied ${suffix}`,farm_id:farmA});
    assert.equal(denied.status,403);
    const otherTeam=await post(adminB,b,{name,scope:'field_ops',farm_id:farmB,notes:'Visit farms'});
    assert.equal(otherTeam.status,201,JSON.stringify(otherTeam.body));
    assert.notEqual(otherTeam.body.data.id,teamId);

    const rows=(await owner.query(
      'SELECT id,tenant_id,name,scope,farm_id,notes FROM teams WHERE tenant_id=$1 ORDER BY name',[a])).rows;
    assert.equal(rows.length,2,'invalid writes and retries must not add duplicate teams');
    const persisted=rows.find(row=>row.id===teamId);
    assert.deepEqual([persisted.tenant_id,persisted.name,persisted.scope,persisted.farm_id,persisted.notes],
      [a,name,'field_ops',farmA,'Visit farms']);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM teams WHERE tenant_id=$1',[b])).rows[0].n,1);
  }finally{
    if(ownerConnected){
      try{
        if(tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      }finally{await owner.end();}
    }
    if(appConnected) await appDb.end();
  }
});
