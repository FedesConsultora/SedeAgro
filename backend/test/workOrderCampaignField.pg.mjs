// 0U.2: real HTTP + PostgreSQL regression for campaign/field consistency.
// Runs ONLY with the existing migrated, seeded, disposable *_test PostGIS setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !appUrl) {
  throw new Error('workOrderCampaignField requires disposable PostgreSQL *_test owner/app URLs.');
}
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'work-order-campaign-field-gate-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('work orders cannot combine different fields or tenants with a campaign-field reference', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/work-orders`;
  const tenants = [];
  const users = [];
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let ownerConnected = false;
  let runtimeConnected = false;

  async function insert(query, params) {
    return (await owner.query(query, params)).rows[0].id;
  }
  async function request(token, tenantId, body) {
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() };
  }
  const order = (fieldId, campaignFieldId, title) => ({
    field_id: fieldId,
    ...(campaignFieldId === undefined ? {} : { campaign_field_id: campaignFieldId }),
    title,
    type: 'inspection'
  });

  try {
    await owner.connect();
    ownerConnected = true;
    await runtime.connect();
    runtimeConnected = true;
    const [{ name: ownerDb }] = (await owner.query('SELECT current_database() AS name')).rows;
    const [{ db: runtimeDb, ...runtimeRole }] = (await runtime.query(`
      SELECT current_database() AS db, r.rolname, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows;
    assert.match(ownerDb, /(?:^|[_-])test(?:$|[_-])/i, 'never mutate production');
    assert.equal(runtimeDb, ownerDb);
    assert.ok(isSafeRuntimeDbRole(runtimeRole), 'API role must not bypass RLS');
    const security = (await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid='public.work_orders'::regclass
    `)).rows[0];
    assert.ok(security.relrowsecurity && security.relforcerowsecurity);
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    const crop = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0];
    assert.ok(plan && crop, 'CI global seed required');

    const a = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Integrity A',$1,'active',$2) RETURNING id",
      [`integrity-a-${suffix}`, plan.id]);
    tenants.push(a);
    const b = await insert(
      "INSERT INTO tenants(name,slug,status,plan_id) VALUES('Integrity B',$1,'active',$2) RETURNING id",
      [`integrity-b-${suffix}`, plan.id]);
    tenants.push(b);

    async function member(tenantId, name, role) {
      const id = await insert(
        'INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,\'fixture\') RETURNING id',
        [name, `integrity-${suffix}-${name.replaceAll(' ', '-')}@example.test`]);
      users.push(id);
      await owner.query(
        "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,$3,'active')",
        [tenantId, id, role]);
      return signSession({ sub: id, role_code: role, tenant_id: tenantId });
    }
    const adminA = await member(a, 'admin a', 'tenant_admin');
    const scoutA = await member(a, 'scout a', 'scout');
    const adminB = await member(b, 'admin b', 'tenant_admin');

    await owner.query(
      "INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES" +
      "($1,'work_orders',true,'plan'),($2,'work_orders',true,'plan')," +
      "($1,'scouting',true,'plan'),($2,'scouting',true,'plan')", [a, b]);

    async function makeField(tenantId, label) {
      const farmId = await insert(
        'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tenantId, `Farm ${label}`]);
      return insert('INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tenantId, farmId, `Field ${label}`]);
    }
    const fieldA1 = await makeField(a, 'A1');
    const fieldA2 = await makeField(a, 'A2');
    const fieldB = await makeField(b, 'B');
    async function makeCampaignField(tenantId, fieldId, label) {
      const campaignId = await insert(
        "INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES($1,$2,2026,'2026-01-01') RETURNING id",
        [tenantId, label]);
      return insert(
        'INSERT INTO campaign_fields(tenant_id,campaign_id,field_id,crop_type_id) VALUES($1,$2,$3,$4) RETURNING id',
        [tenantId, campaignId, fieldId, crop.id]);
    }
    const cfA1 = await makeCampaignField(a, fieldA1, 'A1');
    const cfA2 = await makeCampaignField(a, fieldA2, 'A2');
    const cfB = await makeCampaignField(b, fieldB, 'B');

    const valid = await request(adminA, a, order(fieldA1, cfA1, 'Order with matching crop'));
    assert.equal(valid.status, 201, JSON.stringify(valid.json));
    const saved = (await owner.query(
      'SELECT tenant_id,field_id,campaign_field_id FROM work_orders WHERE id=$1',
      [valid.json.data.id])).rows[0];
    assert.deepEqual([saved.tenant_id, saved.field_id, saved.campaign_field_id],
      [a, fieldA1, cfA1], 'order must persist actual matched parent IDs');

    const withoutCampaign = await request(adminA, a,
      order(fieldA1, undefined, 'Inspection without selected campaign'));
    assert.equal(withoutCampaign.status, 201, JSON.stringify(withoutCampaign.json));
    assert.equal(withoutCampaign.json.data.campaign_field_id, null);

    const before = (await owner.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [a])).rows[0].n;
    assert.equal(before, 2);
    const mismatch = await request(adminA, a,
      order(fieldA1, cfA2, 'Must reject other field in same company'));
    assert.equal(mismatch.status, 422, JSON.stringify(mismatch.json));
    assert.equal(mismatch.json.error.code, 'WORK_ORDER_CAMPAIGN_FIELD_MISMATCH');
    const crossCampaign = await request(adminA, a,
      order(fieldA1, cfB, 'Must hide other company campaign'));
    assert.equal(crossCampaign.status, 404, JSON.stringify(crossCampaign.json));
    const crossField = await request(adminA, a,
      order(fieldB, cfA1, 'Must hide other company field'));
    assert.equal(crossField.status, 404, JSON.stringify(crossField.json));
    const missingCampaign = await request(adminA, a,
      order(fieldA1, randomUUID(), 'Unknown campaign-field'));
    assert.equal(missingCampaign.status, 404, JSON.stringify(missingCampaign.json));
    const noCapability = await request(scoutA, a,
      order(fieldA1, cfA1, 'Scout must not create work orders'));
    assert.equal(noCapability.status, 403);
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [a])).rows[0].n,
    before, 'no invalid or denied orders may persist');

    const validB = await request(adminB, b,
      order(fieldB, cfB, 'Isolated company B valid order'));
    assert.equal(validB.status, 201, JSON.stringify(validB.json));
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [b])).rows[0].n,
    1);
    // Real tenant-local origin check and independent composite-key FK gate.
    const makeSource=async(tid,cf,fid,tag)=>{
      const runId=await insert("INSERT INTO scouting_runs(tenant_id,campaign_field_id) VALUES($1,$2) RETURNING id",[tid,cf]);
      const observationId=await insert("INSERT INTO scouting_observations(tenant_id,scouting_run_id,field_id,observation_type,notes) VALUES($1,$2,$3,'weed',$4) RETURNING id",[tid,runId,fid,tag]);
      return {runId,observationId};
    };
    const own=await makeSource(a,cfA1,fieldA1,'Actual observation');
    const other=await makeSource(a,cfA2,fieldA2,'Different lot');
    const foreign=await makeSource(b,cfB,fieldB,'Foreign observation');
    const linkedBody={...order(fieldA1,cfA1,'Order from observation'),
      origin_observation_id:own.observationId,client_request_id:randomUUID()};
    const first=await request(adminA,a,linkedBody);
    assert.equal(first.status,201,JSON.stringify(first.json));
    assert.deepEqual(first.json.data.observation_origin,
      {scouting_observation_id:own.observationId,scouting_run_id:own.runId});
    const replay=await request(adminA,a,linkedBody);
    assert.equal(replay.status,200,JSON.stringify(replay.json));
    assert.equal(replay.json.data.id,first.json.data.id);
    assert.equal(replay.json.replayed,true);
    const second=await request(adminA,a,{...linkedBody,
      title:'Second inspection of same observation',client_request_id:randomUUID()});
    assert.equal(second.status,201,JSON.stringify(second.json));

    const getLinks=async(token,tenantId,runId)=>{
      const response=await fetch(base+'/observation-links/runs/'+runId,{
        headers:{authorization:'Bearer '+token,'x-tenant-id':tenantId}
      });
      return {status:response.status,json:await response.json(),
        cacheControl:response.headers.get('cache-control')};
    };
    const linked=await getLinks(adminA,a,own.runId);
    assert.equal(linked.status,200,JSON.stringify(linked.json));
    assert.match(linked.cacheControl,/no-store/);
    assert.equal(linked.json.data.scoutingRunId,own.runId);
    assert.equal(linked.json.data.rows.length,2,
      'one observed finding may require two independently authorized orders');
    assert.deepEqual(new Set(linked.json.data.rows.map(item=>item.work_order_id)),
      new Set([first.json.data.id,second.json.data.id]));
    for(const item of linked.json.data.rows){
      assert.equal(item.scouting_observation_id,own.observationId);
      assert.equal(item.status,'draft');
      assert.equal(item.type,'inspection');
      assert.equal(item.priority,'normal');
      assert.ok(item.title);
      assert.deepEqual(Object.keys(item).sort(),
        ['scouting_observation_id','work_order_id','title','type','status','priority'].sort());
    }
    assert.equal(JSON.stringify(linked.json).includes('Actual observation'),false,
      'the list must not leak private scouting notes');
    assert.equal((await getLinks(scoutA,a,own.runId)).status,403);
    assert.equal((await getLinks(adminB,b,own.runId)).status,404);
    assert.equal((await getLinks(adminA,a,foreign.runId)).status,404);
    assert.equal((await getLinks(adminA,a,randomUUID())).status,404);
    const empty=await getLinks(adminB,b,foreign.runId);
    assert.equal(empty.status,200,JSON.stringify(empty.json));
    assert.deepEqual(empty.json.data.rows,[]);
    const emptyLegacy=await getLinks(adminA,a,other.runId);
    assert.equal(emptyLegacy.status,200);
    assert.deepEqual(emptyLegacy.json.data.rows,[]);
    for(const [patch,status,code] of [
      [{origin_observation_id:other.observationId},422,'ORDER_ORIGIN_FIELD_CAMPAIGN_MISMATCH'],
      [{origin_observation_id:foreign.observationId},404,'ORDER_ORIGIN_OBSERVATION_NOT_FOUND'],
      [{campaign_field_id:null},422,'ORDER_ORIGIN_CAMPAIGN_REQUIRED']
    ]) {
      const invalid=await request(adminA,a,{...linkedBody,...patch,client_request_id:randomUUID()});
      assert.equal(invalid.status,status,JSON.stringify(invalid.json));
      assert.equal(invalid.json.error.code,code);
    }
    const noRole=await request(scoutA,a,linkedBody);
    assert.equal(noRole.status,403);
    await assert.rejects(owner.query(`
      INSERT INTO work_order_observation_origins
      (tenant_id,work_order_id,scouting_observation_id,scouting_run_id,
       field_id,campaign_field_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,[a,valid.json.data.id,foreign.observationId,foreign.runId,fieldA1,cfA1,randomUUID()]),
    error=>error.code==='23503');
    assert.equal((await owner.query(
      'SELECT count(*)::int AS n FROM work_order_observation_origins WHERE tenant_id=$1',
      [a])).rows[0].n,2);
  } finally {
    if (ownerConnected) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      } finally {
        await owner.end();
      }
    }
    if (runtimeConnected) await runtime.end();
  }
});
