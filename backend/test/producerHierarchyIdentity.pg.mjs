// Pilot 0U.5: prevent retroactive producer-grant changes via GIS reparenting.
// Real Express HTTP + PostGIS FORCE RLS with disposable *_test database only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !appUrl) throw new Error('producerHierarchyIdentity requires a disposable *_test database.');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'producer-hierarchy-ci-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('farm and field historical ownership never changes which producer can read a lot', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const unique = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let hasOwner = false, hasRuntime = false;
  const insert = async (sql, values) => (await owner.query(sql, values)).rows[0].id;

  async function request(path, token, tenantId, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, json: await response.json() };
  }

  try {
    await owner.connect();
    hasOwner = true;
    await runtime.connect();
    hasRuntime = true;
    const [{ name: ownerDb }] = (await owner.query('SELECT current_database() AS name')).rows;
    const [{ db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(ownerDb, /(?:^|[_-])test(?:$|[_-])/i, 'never touch business databases');
    assert.equal(appDb, ownerDb);
    assert.ok(isSafeRuntimeDbRole(role), 'runtime role must be non-owner without bypass RLS');
    const protections = (await owner.query(`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY['public.farms'::regclass,'public.fields'::regclass,
        'public.producer_access_grants'::regclass])
    `)).rows;
    assert.equal(protections.length, 3);
    for (const p of protections) {
      assert.ok(p.relrowsecurity && p.relforcerowsecurity, p.relname);
    }
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const tenantA = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Producer hierarchy A',$2,'active') RETURNING id",
      [plan.id,`producer-hierarchy-a-${unique}`]);
    tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Producer hierarchy B',$2,'active') RETURNING id",
      [plan.id,`producer-hierarchy-b-${unique}`]);
    tenants.push(tenantB);
    async function member(tenantId, label, roleCode) {
      const userId = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label,`producer-hierarchy-${unique}-${label.replaceAll(' ','-')}@example.test`]);
      users.push(userId);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId,userId,roleCode]);
      return {userId, token: signSession({sub:userId,role_code:roleCode,tenant_id:tenantId})};
    }
    const adminA=await member(tenantA,'admin a','tenant_admin');
    const viewerA=await member(tenantA,'viewer a','producer_viewer');
    const viewerB=await member(tenantA,'viewer b','producer_viewer');
    const adminB=await member(tenantB,'admin b','tenant_admin');
    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
      "($1,'gis',true,'plan'),($2,'gis',true,'plan')", [tenantA,tenantB]);

    const producerA=await insert('INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantA,`Producer A ${unique}`]);
    const producerB=await insert('INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantA,`Producer B ${unique}`]);
    const producerOther=await insert('INSERT INTO producers(tenant_id,name) VALUES($1,$2) RETURNING id',
      [tenantB,`Producer other ${unique}`]);
    async function farm(tid, producer, label) {
      return insert('INSERT INTO farms(tenant_id,producer_id,name) VALUES($1,$2,$3) RETURNING id',
        [tid,producer,`Farm ${label} ${unique}`]);
    }
    const farmA=await farm(tenantA,producerA,'A');
    const farmB=await farm(tenantA,producerB,'B');
    const farmUnassignedWithField=await farm(tenantA,null,'unassigned with history');
    const farmUnassignedEmpty=await farm(tenantA,null,'unassigned empty');
    const farmOther=await farm(tenantB,producerOther,'other');
    async function field(tid,farmId,label) {
      return insert('INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tid,farmId,`Field ${label} ${unique}`]);
    }
    const fieldA=await field(tenantA,farmA,'A');
    const fieldB=await field(tenantA,farmB,'B');
    const fieldUnassigned=await field(tenantA,farmUnassignedWithField,'historical');
    const fieldOther=await field(tenantB,farmOther,'other');

    for (const [userId, producerId] of [[viewerA.userId,producerA],[viewerB.userId,producerB]]) {
      await owner.query(
        'INSERT INTO producer_access_grants(tenant_id,user_id,producer_id,granted_by) VALUES($1,$2,$3,$4)',
        [tenantA,userId,producerId,adminA.userId]);
    }
    async function ids(path, token) {
      const result=await request(path,token,tenantA);
      assert.equal(result.status,200,JSON.stringify(result.json));
      return result.json.data.map(item=>item.id);
    }
    assert.deepEqual(await ids('/fields',viewerA.token),[fieldA]);
    assert.deepEqual(await ids('/fields',viewerB.token),[fieldB]);
    assert.equal((await request(`/fields/${fieldB}`,viewerA.token,tenantA)).status,404);
    assert.equal((await request(`/fields/${fieldA}`,viewerB.token,tenantA)).status,404);
    assert.equal((await request(`/farms/${farmB}`,viewerA.token,tenantA)).status,404);

    const wrongFieldFarm=await request(`/fields/${fieldB}`,adminA.token,tenantA,'PATCH',
      {farm_id:farmA});
    assert.equal(wrongFieldFarm.status,409,JSON.stringify(wrongFieldFarm.json));
    assert.equal(wrongFieldFarm.json.error.code,'FIELD_FARM_IDENTITY_IMMUTABLE');
    const wrongFarmProducer=await request(`/farms/${farmB}`,adminA.token,tenantA,'PATCH',
      {producer_id:producerA});
    assert.equal(wrongFarmProducer.status,409,JSON.stringify(wrongFarmProducer.json));
    assert.equal(wrongFarmProducer.json.error.code,'FARM_PRODUCER_IDENTITY_IMMUTABLE');
    const removeProducer=await request(`/farms/${farmB}`,adminA.token,tenantA,'PATCH',
      {producer_id:null});
    assert.equal(removeProducer.status,409);
    const assignHistorical=await request(`/farms/${farmUnassignedWithField}`,
      adminA.token,tenantA,'PATCH',{producer_id:producerA});
    assert.equal(assignHistorical.status,409,JSON.stringify(assignHistorical.json));

    assert.deepEqual(await ids('/fields',viewerA.token),[fieldA]);
    assert.deepEqual(await ids('/fields',viewerB.token),[fieldB]);
    assert.equal((await request(`/fields/${fieldB}`,viewerA.token,tenantA)).status,404);
    assert.equal((await request(`/fields/${fieldA}`,viewerB.token,tenantA)).status,404);

    const validFieldUpdate=await request(`/fields/${fieldB}`,adminA.token,tenantA,
      'PATCH',{farm_id:farmB,notes:'Inspection notes updated'});
    assert.equal(validFieldUpdate.status,200,JSON.stringify(validFieldUpdate.json));
    const validFarmUpdate=await request(`/farms/${farmB}`,adminA.token,tenantA,
      'PATCH',{producer_id:producerB,locality:'La Plata'});
    assert.equal(validFarmUpdate.status,200,JSON.stringify(validFarmUpdate.json));
    const safeInitialAssignment=await request(`/farms/${farmUnassignedEmpty}`,
      adminA.token,tenantA,'PATCH',{producer_id:producerA});
    assert.equal(safeInitialAssignment.status,200,JSON.stringify(safeInitialAssignment.json));
    assert.equal(safeInitialAssignment.json.data.producer_id,producerA);

    const deniedViewerField=await request(`/fields/${fieldB}`,viewerA.token,tenantA,
      'PATCH',{name:'Unauthorized edit'});
    assert.equal(deniedViewerField.status,403);
    const deniedViewerFarm=await request(`/farms/${farmB}`,viewerA.token,tenantA,
      'PATCH',{name:'Unauthorized edit'});
    assert.equal(deniedViewerFarm.status,403);
    const crossField=await request(`/fields/${fieldOther}`,adminA.token,tenantA,
      'PATCH',{name:'Cross-tenant edit'});
    assert.equal(crossField.status,404);
    const crossFarm=await request(`/farms/${farmOther}`,adminA.token,tenantA,
      'PATCH',{name:'Cross-tenant edit'});
    assert.equal(crossFarm.status,404);
    const otherTenantValid=await request(`/fields/${fieldOther}`,adminB.token,tenantB,
      'PATCH',{notes:'Own tenant'});
    assert.equal(otherTenantValid.status,200,JSON.stringify(otherTenantValid.json));

    const [savedField,savedFarm,savedUnassigned,savedEmpty] = await Promise.all([
      owner.query('SELECT farm_id,notes FROM fields WHERE id=$1',[fieldB]),
      owner.query('SELECT producer_id,locality FROM farms WHERE id=$1',[farmB]),
      owner.query('SELECT producer_id FROM farms WHERE id=$1',[farmUnassignedWithField]),
      owner.query('SELECT producer_id FROM farms WHERE id=$1',[farmUnassignedEmpty])
    ]);
    assert.equal(savedField.rows[0].farm_id,farmB);
    assert.equal(savedField.rows[0].notes,'Inspection notes updated');
    assert.equal(savedFarm.rows[0].producer_id,producerB);
    assert.equal(savedFarm.rows[0].locality,'La Plata');
    assert.equal(savedUnassigned.rows[0].producer_id,null);
    assert.equal(savedEmpty.rows[0].producer_id,producerA);
    assert.equal((await owner.query('SELECT farm_id FROM fields WHERE id=$1',[fieldUnassigned])).rows[0].farm_id,
      farmUnassignedWithField);
  } finally {
    if(hasOwner) {
      try {
        if(tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      } finally {await owner.end();}
    }
    if(hasRuntime) await runtime.end();
  }
});
