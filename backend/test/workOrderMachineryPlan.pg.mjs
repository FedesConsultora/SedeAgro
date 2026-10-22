// 0U.7: authorized, immutable order machinery planning under PostGIS FORCE RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !runtimeUrl) throw new Error('workOrderMachineryPlan needs disposable *_test owner/app URLs.');
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'machinery-plan-test-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('machine planning denies inactive resources and approved orders, and retries keep original row', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const appDb = new pg.Client({ connectionString: runtimeUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerConnected = false, appConnected = false;
  const insert = async (sql, values) => (await owner.query(sql, values)).rows[0].id;
  async function request(path, token, tenantId, method='POST', body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`, 'x-tenant-id': tenantId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    await owner.connect(); ownerConnected = true;
    await appDb.connect(); appConnected = true;
    const [{ db }] = (await owner.query('SELECT current_database() AS db')).rows;
    const [{ name: runtimeDb, ...dbRole }] = (await appDb.query(`
      SELECT current_database() AS name,r.rolname,r.rolsuper,r.rolbypassrls,
        r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(runtimeDb, db);
    assert.ok(isSafeRuntimeDbRole(dbRole), 'app role cannot bypass tenant RLS');
    const policies = (await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid=ANY(ARRAY[
        'public.work_orders'::regclass,'public.machinery'::regclass,
        'public.work_order_machinery'::regclass])
    `)).rows;
    assert.equal(policies.length, 3);
    for (const row of policies) {
      assert.ok(row.relrowsecurity && row.relforcerowsecurity, row.relname);
    }
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan, 'global CI seed required');
    const a=await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Machinery plan A',$2,'active') RETURNING id",
      [plan.id,`machinery-plan-a-${suffix}`]);
    tenants.push(a);
    const b=await insert(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,'Machinery plan B',$2,'active') RETURNING id",
      [plan.id,`machinery-plan-b-${suffix}`]);
    tenants.push(b);
    async function member(tid,label,role) {
      const id=await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        [label,`machinery-plan-${suffix}-${label.replaceAll(' ','-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tid,id,role]);
      return signSession({sub:id,role_code:role,tenant_id:tid});
    }
    const adminA=await member(a,'admin a','tenant_admin');
    const coordinatorA=await member(a,'coordinator a','agronomic_coordinator');
    const scoutA=await member(a,'scout a','scout');
    const adminB=await member(b,'admin b','tenant_admin');
    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
      "($1,'work_orders',true,'plan'),($2,'work_orders',true,'plan')",[a,b]);
    async function newField(tid,label) {
      const farm=await insert('INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tid,`Machinery farm ${label} ${suffix}`]);
      return insert('INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tid,farm,`Machinery field ${label}`]);
    }
    const fieldA=await newField(a,'A'),fieldB=await newField(b,'B');
    const orderA=await request('/work-orders',adminA,a,'POST',
      {field_id:fieldA,type:'inspection',title:'Machinery baseline draft'});
    assert.equal(orderA.status,201,JSON.stringify(orderA.body));
    const orderId=orderA.body.data.id;
    const orderB=await request('/work-orders',adminB,b,'POST',
      {field_id:fieldB,type:'inspection',title:'Other organization order'});
    assert.equal(orderB.status,201,JSON.stringify(orderB.body));
    async function machine(tid,status,label) {
      return insert(
        'INSERT INTO machinery(tenant_id,name,kind,status) VALUES($1,$2,$3,$4) RETURNING id',
        [tid,`Machine ${label} ${suffix}`,'tractor',status]);
    }
    const active=await machine(a,'active','active');
    const secondActive=await machine(a,'active','second');
    const maintenance=await machine(a,'maintenance','maintenance');
    const inactive=await machine(a,'inactive','inactive');
    const archived=await machine(a,'archived','archived');
    const foreign=await machine(b,'active','other tenant');
    const path=`/work-orders/${orderId}/machinery`;
    const planMachine=(machineId,role='primary') => ({machinery_id:machineId,role});

    const first=await request(path,adminA,a,'POST',planMachine(active));
    assert.equal(first.status,201,JSON.stringify(first.body));
    const assignedId=first.body.data.id;
    const replay=await request(path,adminA,a,'POST',planMachine(active));
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.equal(replay.body.data.id,assignedId);
    assert.equal(replay.body.replayed,true);
    const conflicting=await request(path,adminA,a,'POST',planMachine(active,'secondary'));
    assert.equal(conflicting.status,409,JSON.stringify(conflicting.body));
    assert.equal(conflicting.body.error.code,'WORK_ORDER_MACHINERY_ROLE_CONFLICT');

    const planned=await request(path,coordinatorA,a,'POST',planMachine(secondActive,'support'));
    assert.equal(planned.status,201,JSON.stringify(planned.body));
    for (const machineId of [maintenance,inactive,archived]) {
      const denied=await request(path,adminA,a,'POST',planMachine(machineId));
      assert.equal(denied.status,422,JSON.stringify(denied.body));
      assert.equal(denied.body.error.code,'WORK_ORDER_MACHINERY_UNAVAILABLE');
    }
    const missing=await request(path,adminA,a,'POST',planMachine(randomUUID()));
    assert.equal(missing.status,422,JSON.stringify(missing.body));
    const otherOrg=await request(path,adminA,a,'POST',planMachine(foreign));
    assert.equal(otherOrg.status,422,JSON.stringify(otherOrg.body));
    const noOrder=await request(`/work-orders/${randomUUID()}/machinery`,
      adminA,a,'POST',planMachine(active));
    assert.equal(noOrder.status,404,JSON.stringify(noOrder.body));
    const otherOrder=await request(`/work-orders/${orderB.body.data.id}/machinery`,
      adminA,a,'POST',planMachine(active));
    assert.equal(otherOrder.status,404,JSON.stringify(otherOrder.body));
    const noPermission=await request(path,scoutA,a,'POST',planMachine(active));
    assert.equal(noPermission.status,403);

    await owner.query("UPDATE work_orders SET status='pending_approval' WHERE id=$1",[orderId]);
    const inReview=await request(path,adminA,a,'POST',planMachine(secondActive,'support'));
    assert.equal(inReview.status,200,JSON.stringify(inReview.body));
    await owner.query("UPDATE work_orders SET status='approved' WHERE id=$1",[orderId]);
    for (const status of ['approved','assigned','in_progress','completed','cancelled']) {
      if(status!=='approved') await owner.query('UPDATE work_orders SET status=$1 WHERE id=$2',[status,orderId]);
      const frozen=await request(path,adminA,a,'POST',planMachine(active));
      assert.equal(frozen.status,409,JSON.stringify(frozen.body));
      assert.equal(frozen.body.error.code,'WORK_ORDER_MACHINERY_PLAN_FROZEN');
    }
    const rows=(await owner.query(
      'SELECT machinery_id,role,id FROM work_order_machinery WHERE tenant_id=$1 AND work_order_id=$2 ORDER BY machinery_id',
      [a,orderId])).rows;
    assert.equal(rows.length,2,'retries and rejected associations must not persist');
    assert.equal(rows.find(row=>row.machinery_id===active).id,assignedId);
    assert.equal(rows.find(row=>row.machinery_id===active).role,'primary');
    assert.equal(rows.find(row=>row.machinery_id===secondActive).role,'support');
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM work_order_machinery WHERE tenant_id=$1',
      [b])).rows[0].n,0);
  } finally {
    if(ownerConnected) {
      try {
        if(tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      } finally {await owner.end();}
    }
    if(appConnected) await appDb.end();
  }
});
