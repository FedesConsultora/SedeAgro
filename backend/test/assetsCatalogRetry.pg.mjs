// 0U.17: retry-safe catalog assets with immutable recorded provenance.
// HTTP + disposable migrated PostGIS with runtime non-owner FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !appUrl) throw new Error('assetsCatalogRetry requires disposable *_test owner/app URLs');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'asset-catalog-retry-test-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('asset catalog retries reuse valid identities but never rewrite existing machinery or inputs', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/assets`;
  const salt = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerConnected = false, runtimeConnected = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;
  async function request(path, token, tenantId, method = 'POST', data) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        ...(data === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    return { status: response.status, json: await response.json() };
  }

  try {
    await owner.connect(); ownerConnected = true;
    await runtime.connect(); runtimeConnected = true;
    const [{ db }] = (await owner.query('SELECT current_database() AS db')).rows;
    const [{ app_db: appDb, ...role }] = (await runtime.query(`
      SELECT current_database() AS app_db, r.rolname, r.rolsuper,
        r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
        pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(appDb, db);
    assert.ok(isSafeRuntimeDbRole(role), 'runtime must be a non-owner and cannot bypass RLS');
    const secured = (await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY[
        'public.machinery'::regclass,'public.agricultural_inputs'::regclass])
    `)).rows;
    assert.equal(secured.length, 2);
    for (const row of secured) {
      assert.ok(row.relrowsecurity && row.relforcerowsecurity, row.relname);
    }
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const tenantA = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Asset retry A',$2,'active') RETURNING id",
      [plan.id,`asset-retry-a-${salt}`]); tenants.push(tenantA);
    const tenantB = await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Asset retry B',$2,'active') RETURNING id",
      [plan.id,`asset-retry-b-${salt}`]); tenants.push(tenantB);
    async function member(tenantId, label, roleCode) {
      const userId = await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label,`asset-retry-${salt}-${label.replaceAll(' ','-')}@example.test`]);
      users.push(userId);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId,userId,roleCode]);
      return signSession({sub:userId,role_code:roleCode,tenant_id:tenantId});
    }
    const adminA = await member(tenantA,'admin a','tenant_admin');
    const coordA = await member(tenantA,'coord a','agronomic_coordinator');
    const contractorA = await member(tenantA,'contractor a','contractor');
    const adminB = await member(tenantB,'admin b','tenant_admin');
    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
      "($1,'work_orders',true,'plan'),($2,'work_orders',true,'plan')",
      [tenantA,tenantB]);

    const machine = {
      name: `Pilot tractor ${salt}`,kind:'tractor',
      brand:'Test manufacturer',model:'T100',serial_number:`SN-${salt}`,
      status:'active',metadata:{year:2026,parts:{engine:'diesel',hp:95}}
    };
    const deniedMachinery = await request('/machinery',contractorA,tenantA,'POST',machine);
    assert.equal(deniedMachinery.status,403,JSON.stringify(deniedMachinery.json));
    const firstMachine = await request('/machinery',adminA,tenantA,'POST',machine);
    assert.equal(firstMachine.status,201,JSON.stringify(firstMachine.json));
    const machineId = firstMachine.json.data.id;
    const replayMachine = await request('/machinery',coordA,tenantA,'POST',{
      ...machine,metadata:{parts:{hp:95,engine:'diesel'},year:2026}
    });
    assert.equal(replayMachine.status,200,JSON.stringify(replayMachine.json));
    assert.equal(replayMachine.json.data.id,machineId);
    assert.equal(replayMachine.json.replayed,true);
    for (const changed of [
      {...machine,name:`New name ${salt}`},
      {...machine,kind:'seeder'},
      {...machine,status:'maintenance'},
      {...machine,metadata:{year:2026,parts:{engine:'electric',hp:95}}}
    ]) {
      const conflict = await request('/machinery',adminA,tenantA,'POST',changed);
      assert.equal(conflict.status,409,JSON.stringify(conflict.json));
      assert.equal(conflict.json.error.code,'ASSET_MACHINERY_CONFLICT');
    }

    const noSerial={name:`Tractor no series ${salt}`,kind:'tractor'};
    const serialless1 = await request('/machinery',adminA,tenantA,'POST',noSerial);
    const serialless2 = await request('/machinery',adminA,tenantA,'POST',noSerial);
    assert.equal(serialless1.status,201,JSON.stringify(serialless1.json));
    assert.equal(serialless2.status,201,JSON.stringify(serialless2.json));
    assert.notEqual(serialless1.json.data.id,serialless2.json.data.id,
      'machinery without a serial number cannot be automatically deduplicated');
    const crossMachine = await request('/machinery',adminB,tenantB,'POST',machine);
    assert.equal(crossMachine.status,201,JSON.stringify(crossMachine.json));
    assert.notEqual(crossMachine.json.data.id,machineId);

    const input={
      name:`Fertilizer ${salt}`,category:'fertilizer',unit:'kg',
      active_ingredient:'NPK',registration_number:`REG-${salt}`,
      metadata:{application:{maxPerHa:12,route:'broadcast'},approved:true}
    };
    const deniedInput = await request('/inputs',contractorA,tenantA,'POST',input);
    assert.equal(deniedInput.status,403,JSON.stringify(deniedInput.json));
    const firstInput = await request('/inputs',adminA,tenantA,'POST',input);
    assert.equal(firstInput.status,201,JSON.stringify(firstInput.json));
    const inputId=firstInput.json.data.id;
    const replayInput = await request('/inputs',coordA,tenantA,'POST',{
      ...input,metadata:{approved:true,application:{route:'broadcast',maxPerHa:12}}
    });
    assert.equal(replayInput.status,200,JSON.stringify(replayInput.json));
    assert.equal(replayInput.json.data.id,inputId);
    assert.equal(replayInput.json.replayed,true);
    for(const changed of [
      {...input,unit:'L'},
      {...input,category:'seed'},
      {...input,registration_number:'UNRELATED'},
      {...input,metadata:{application:{maxPerHa:100},approved:true}}
    ]) {
      const conflict = await request('/inputs',adminA,tenantA,'POST',changed);
      assert.equal(conflict.status,409,JSON.stringify(conflict.json));
      assert.equal(conflict.json.error.code,'ASSET_INPUT_CONFLICT');
    }
    const crossInput = await request('/inputs',adminB,tenantB,'POST',input);
    assert.equal(crossInput.status,201,JSON.stringify(crossInput.json));
    assert.notEqual(crossInput.json.data.id,inputId);

    const equipment=(await owner.query(
      'SELECT id,name,kind,status,brand,model,metadata FROM machinery WHERE tenant_id=$1 ORDER BY name,id',
      [tenantA])).rows;
    assert.equal(equipment.length,3,'only the serial-number machine and two distinct unnumbered tractors persist');
    const recordedMachine=equipment.find(row=>row.id===machineId);
    assert.equal(recordedMachine.name,machine.name);
    assert.equal(recordedMachine.kind,'tractor');
    assert.equal(recordedMachine.status,'active');
    assert.deepEqual(recordedMachine.metadata,machine.metadata);
    const products=(await owner.query(
      'SELECT id,name,category,unit,registration_number,metadata FROM agricultural_inputs WHERE tenant_id=$1',
      [tenantA])).rows;
    assert.equal(products.length,1);
    assert.equal(products[0].id,inputId);
    assert.equal(products[0].unit,'kg');
    assert.equal(products[0].registration_number,input.registration_number);
    assert.deepEqual(products[0].metadata,input.metadata);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM machinery WHERE tenant_id=$1',[tenantB])).rows[0].n,1);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM agricultural_inputs WHERE tenant_id=$1',[tenantB])).rows[0].n,1);
  } finally {
    if (ownerConnected) {
      try {
        if(tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      } finally { await owner.end(); }
    }
    if(runtimeConnected) await runtime.end();
  }
});
