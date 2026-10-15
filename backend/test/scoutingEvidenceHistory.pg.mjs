// High-volume, read-only HTTP pagination acceptance on a disposable PostGIS DB.
// Seeds metadata ONLY (no bytes) so privacy and query bounds remain visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Disposable *_test database required');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'history-load-ci-only-secret';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');

test('750 historic evidences: 30 bounded keyset pages, neighboring run isolation and live reassignment', async t => {
  const owner = new pg.Client({ connectionString: adminUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const suffix = randomUUID().slice(0, 8);
  const tenantIds = [], userIds = [];
  let connected = false;
  try {
    await owner.connect();
    connected = true;
    const { rows: [{ name }] } = await owner.query('SELECT current_database() AS name');
    assert.match(name, /(?:^|[_-])test(?:$|[_-])/i, 'no production database writes');
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0]?.id;
    const crop = (await owner.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0]?.id;
    assert.ok(plan && crop);
    async function insert(sql, params) { return (await owner.query(sql, params)).rows[0].id; }
    const tenant = await insert("INSERT INTO tenants(name,slug,plan_id,status) VALUES ($1,$2,$3,'active') RETURNING id",
      ['Evidence history A', `history-load-a-${suffix}`, plan]);
    tenantIds.push(tenant);
    const tenantB = await insert("INSERT INTO tenants(name,slug,plan_id,status) VALUES ($1,$2,$3,'active') RETURNING id",
      ['Evidence history B', `history-load-b-${suffix}`, plan]);
    tenantIds.push(tenantB);
    const userA = await insert("INSERT INTO users(full_name,email,password_hash) VALUES ('History scout',$1,'fixture') RETURNING id",
      [`history-scout-${suffix}@example.test`]);userIds.push(userA);
    const userB = await insert("INSERT INTO users(full_name,email,password_hash) VALUES ('Other scout',$1,'fixture') RETURNING id",
      [`history-other-${suffix}@example.test`]);userIds.push(userB);
    await owner.query("INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES ($1,$2,'scout','active'),($1,$3,'scout','active')",
      [tenant,userA,userB]);
    await owner.query("INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) VALUES ($1,'scouting',true,'plan')",[tenant]);
    const farm = await insert('INSERT INTO farms(tenant_id,name) VALUES ($1,$2) RETURNING id',[tenant,'History farm']);
    const field = await insert('INSERT INTO fields(tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id',
      [tenant,farm,'History field']);
    const campaign = await insert("INSERT INTO campaigns(tenant_id,name,season_year,starts_at) VALUES ($1,'History season',2026,'2026-01-01') RETURNING id",
      [tenant]);
    const campaignField = await insert("INSERT INTO campaign_fields(tenant_id,campaign_id,field_id,crop_type_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [tenant,campaign,field,crop]);
    const run = await insert("INSERT INTO scouting_runs(tenant_id,campaign_field_id,assigned_to,status) VALUES ($1,$2,$3,'in_progress') RETURNING id",
      [tenant,campaignField,userA]);
    const otherRun = await insert("INSERT INTO scouting_runs(tenant_id,campaign_field_id,assigned_to,status) VALUES ($1,$2,$3,'in_progress') RETURNING id",
      [tenant,campaignField,userB]);
    const obs = await insert("INSERT INTO scouting_observations(tenant_id,scouting_run_id,field_id,observed_by,observation_type) VALUES ($1,$2,$3,$4,'weed') RETURNING id",
      [tenant,run,field,userA]);
    const obsOther = await insert("INSERT INTO scouting_observations(tenant_id,scouting_run_id,field_id,observed_by,observation_type) VALUES ($1,$2,$3,$4,'weed') RETURNING id",
      [tenant,otherRun,field,userB]);

    // Contiguous SQL generation is bounded and only writes disposable metadata.
    for (const [observation, actor, count] of [[obs,userA,750],[obsOther,userB,250]]) {
      await owner.query(`
        INSERT INTO evidence_assets
          (tenant_id, scouting_observation_id, uploaded_by, kind,
            storage_key, mime_type, size_bytes, created_at)
        SELECT $1, $2, $3, 'photo',
          'test-history:' || g::text, 'image/png', 12,
          '2026-10-15T12:00:00Z'::timestamptz - ((g / 3)::text || ' milliseconds')::interval
        FROM generate_series(1, $4::int) AS g
      `, [tenant,observation,actor,count]);
    }
    const indexes = (await owner.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN ('idx_evidence_scouting_tenant_history',
                         'idx_scouting_observations_tenant_run_id')
      ORDER BY indexname
    `)).rows;
    assert.equal(indexes.length, 2, 'migration must create both history indexes');
    assert.match(indexes[0].indexdef + indexes[1].indexdef, /created_at DESC/);
    assert.match(indexes[0].indexdef + indexes[1].indexdef, /scouting_run_id/);

    const expected = (await owner.query(
      'SELECT id FROM evidence_assets WHERE tenant_id=$1 AND scouting_observation_id=$2 ORDER BY created_at DESC, id DESC',
      [tenant,obs])).rows.map(row => row.id);
    assert.equal(expected.length,750);
    const scoutToken = signSession({ sub:userA, role_code:'scout', tenant_id:tenant });
    const otherToken = signSession({ sub:userB, role_code:'scout', tenant_id:tenant });
    const root = `http://127.0.0.1:${server.address().port}/api/v1/scouting/runs/${run}/evidence-status`;
    const request = async (token, cursor=null, tenantHeader=tenant) => {
      const url = `${root}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await fetch(url,{headers:{
        authorization:`Bearer ${token}`, 'x-tenant-id':tenantHeader
      }});
      return { status:response.status, body:await response.json(), headers:response.headers };
    };
    let cursor=null, page=0;
    const all=[];
    do {
      const result=await request(scoutToken,cursor);
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal(result.headers.get('cache-control'),'private, no-store');
      assert.equal(result.body.data.run_id,run);
      assert.equal(result.body.data.limit,25);
      assert.ok(result.body.data.items.length<=25);
      assert.ok(result.body.data.items.every(item=>item.scouting_observation_id===obs));
      assert.ok(result.body.data.items.every(item=>item.bytes_available===false));
      for(const record of result.body.data.items) {
        assert.equal(Object.hasOwn(record,'content_base64'),false);
        assert.equal(Object.hasOwn(record,'content_sha256'),false);
        all.push(record.id);
      }
      page+=1;
      if(page===5) {
        // Revocation applies to NEXT HTTP call, not just the initial cursor.
        await owner.query('UPDATE scouting_runs SET assigned_to=$2 WHERE id=$1',[run,userB]);
        assert.equal((await request(scoutToken,result.body.data.next_cursor)).status,404);
        assert.equal((await request(otherToken,result.body.data.next_cursor)).status,200);
        assert.equal((await request(scoutToken,result.body.data.next_cursor,tenantB)).status,403);
        await owner.query('UPDATE scouting_runs SET assigned_to=$2 WHERE id=$1',[run,userA]);
      }
      cursor=result.body.data.next_cursor;
      assert.equal(result.body.data.has_more, Boolean(cursor));
      assert.ok(page<=32,'no cyclic cursor or unbounded history');
    } while(cursor);
    assert.equal(page,30);
    assert.equal(all.length,750);
    assert.equal(new Set(all).size,750,'no duplication while sorting timestamp ties');
    assert.deepEqual(all,expected,'every page matches global deterministic keyset order');
    assert.ok(!all.includes((await owner.query('SELECT id FROM evidence_assets WHERE scouting_observation_id=$1 LIMIT 1',[obsOther])).rows[0].id));
  } finally {
    if(connected) {
      try {
        if(tenantIds.length)await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenantIds]);
        if(userIds.length)await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[userIds]);
      } finally { await owner.end(); }
    }
  }
});
