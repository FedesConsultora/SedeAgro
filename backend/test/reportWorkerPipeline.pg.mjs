// RP-02: REAL HTTP -> FORCE RLS queue -> tenant-bound worker -> private bytes.
// Runs only with two disposable *_test PostGIS connections. No API mocks,
// production data, external services, or automatic GO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl=process.env.TEST_DATABASE_ADMIN_URL;
const appUrl=process.env.TEST_DATABASE_APP_URL;
function disposable(url) {
  try { return /(?:^|[_-])test(?:$|[_-])/i.test(new URL(url).pathname); }
  catch { return false; }
}
if (!disposable(ownerUrl)||!disposable(appUrl)) {
  throw new Error('RP-02 worker E2E requires two disposable *_test PostGIS URLs');
}
process.env.DATABASE_URL=appUrl;
process.env.NODE_ENV='test';
process.env.JWT_SECRET='disposable-RP02-acceptance-only';

const { createApp }=await import('../src/app.js');
const { sequelize }=await import('../src/core/db.js');
const { signSession }=await import('../src/utils/jwt.js');
const { markReportWorkerPresent,processNextReport,purgeExpiredReportFiles }=
  await import('../src/modules/reports/reportWorker.js');

test('RP-02 real API and worker: offline -> queue -> SHA download -> cancel -> revoke -> expiry, with RLS',async()=>{
  const owner=new pg.Client({connectionString:ownerUrl});
  const app=new pg.Client({connectionString:appUrl});
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const origin='http://127.0.0.1:'+server.address().port+'/api/v1';
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const tenants=[],users=[];
  let ownerReady=false,appReady=false;
  const insert=async(sql,args)=>(await owner.query(sql,args)).rows[0].id;
  async function request(path,actor,{method='GET',body}={}) {
    const response=await fetch(origin+path,{
      method,
      headers:{
        authorization:'Bearer '+actor.token,
        'x-tenant-id':actor.tenant,
        ...(body===undefined?{}:{'content-type':'application/json'})
      },
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const raw=await response.text();
    return {
      status:response.status,
      result:raw?JSON.parse(raw):null,
      cache:response.headers.get('cache-control')
    };
  }
  function expectStatus(value,status,label) {
    assert.equal(value.status,status,label+' (HTTP '+value.status+')');
    return value.result?.data;
  }
  try {
    await owner.connect();ownerReady=true;
    await app.connect();appReady=true;
    const [odb,arole]=await Promise.all([
      owner.query('SELECT current_database() AS db'),
      app.query('SELECT current_database() AS db, r.rolsuper, r.rolbypassrls, '+
        'pg_get_userbyid(d.datdba) AS db_owner, current_user AS role '+
        'FROM pg_roles r JOIN pg_database d ON d.datname=current_database() '+
        'WHERE r.rolname=current_user')
    ]);
    assert.match(odb.rows[0].db,/(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(arole.rows[0].db,odb.rows[0].db);
    assert.equal(arole.rows[0].rolsuper,false);
    assert.equal(arole.rows[0].rolbypassrls,false);
    assert.notEqual(arole.rows[0].role,arole.rows[0].db_owner);
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);

    async function tenant(label) {
      const tenantId=await insert(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES ($1,$2,$3,'active') RETURNING id",
        [plan.id,'RP02 '+label,'rp02-'+label+'-'+suffix]);
      tenants.push(tenantId);
      const userId=await insert(
        "INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,'fixture') RETURNING id",
        ['RP02 '+label,'rp02-'+label+'-'+suffix+'@example.test']);
      users.push(userId);
      await owner.query("INSERT INTO memberships(tenant_id,user_id,role_code,status) "+
        "VALUES ($1,$2,'tenant_admin','active')",[tenantId,userId]);
      await owner.query("INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) "+
        "VALUES ($1,'reports',true,'plan')",[tenantId]);
      return {tenant:tenantId,user:userId,
        token:signSession({sub:userId,tenant_id:tenantId,role_code:'tenant_admin'})};
    }
    const a=await tenant('a');
    const b=await tenant('b');
    const farm=await insert(
      'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
      [a.tenant,'RP02 Field Farm']);
    const field=await insert(
      'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
      [a.tenant,farm,'RP02 Test Field']);
    const template=expectStatus(await request('/reports/templates',a,{
      method:'POST',body:{name:'Pilot Field CSV',code:'rp02-'+suffix,
        scope:'field',format:'csv',config:{},is_active:true}
    }),201,'create tenant template over HTTP');
    assert.equal(template.tenant_id,a.tenant);
    const runBody={report_template_id:template.id,filters:{field_id:field}};

    // A heartbeat is required before the API will enqueue durable jobs.
    const unavailable=await request('/reports/runs',a,{method:'POST',body:runBody});
    expectStatus(unavailable,503,'no background worker must not enqueue');
    assert.equal((await request('/reports/worker-status',a)).result.data.online,false);
    await markReportWorkerPresent(a.tenant);
    const online=await request('/reports/worker-status',a);
    expectStatus(online,200,'authenticated worker online');
    assert.equal(online.result.data.online,true);
    assert.equal(online.cache,'private, no-store');

    const queued=expectStatus(await request('/reports/runs',a,{
      method:'POST',body:runBody}),202,'enqueue report');
    assert.equal(queued.status,'queued');
    assert.equal(queued.attempt_count,0);
    assert.equal((await request('/reports/runs/'+queued.id,a)).result.data.status,'queued');
    expectStatus(await request('/reports/runs/'+queued.id+'/download',a),
      409,'file not available before actual rendering');
    expectStatus(await request('/reports/runs/'+queued.id,b),
      404,'cross-tenant run hidden');
    expectStatus(await request('/reports/runs/'+queued.id+'/download',b),
      404,'cross-tenant file hidden');
    assert.equal((await processNextReport(b.tenant)).state,'idle',
      'worker in tenant B must not claim tenant A report');

    const job=await processNextReport(a.tenant);
    assert.equal(job.state,'completed','real worker must generate and persist bytes');
    assert.equal(job.id,queued.id);
    const after=expectStatus(await request('/reports/runs/'+queued.id,a),
      200,'downloadable completed run');
    assert.equal(after.status,'completed');
    assert.equal(after.attempt_count,1);
    const download=await request('/reports/runs/'+queued.id+'/download',a);
    const file=expectStatus(download,200,'fetch private generated CSV');
    assert.equal(download.cache,'private, no-store');
    assert.equal(file.mimeType,'text/csv;charset=utf-8');
    assert.equal(file.filename,'reporte-lote-'+field+'.csv');
    const bytes=Buffer.from(file.content_base64,'base64');
    assert.equal(bytes.length,file.size_bytes);
    assert.ok(bytes.length>32);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    assert.ok(bytes.toString('utf8').includes('RP02 Test Field'));
    expectStatus(await request('/reports/runs/'+queued.id+'/download',b),
      404,'foreign company cannot download completed file');
    const rows=await owner.query(
      "SELECT r.status,r.attempt_count,count(f.run_id)::integer AS files "+
      "FROM report_runs r LEFT JOIN report_run_files f "+
      "ON f.tenant_id=r.tenant_id AND f.run_id=r.id "+
      "WHERE r.tenant_id=$1 AND r.id=$2 "+
      "GROUP BY r.status,r.attempt_count",
      [a.tenant,queued.id]);
    assert.deepEqual(rows.rows,[{status:'completed',attempt_count:1,files:1}]);
    assert.equal((await processNextReport(a.tenant)).state,'idle',
      'completed run cannot be rendered twice');

    // Cancelled jobs cannot be resurrected by a later worker invocation.
    const pending=expectStatus(await request('/reports/runs',a,{
      method:'POST',body:runBody}),202,'enqueue cancel candidate');
    const cancelled=expectStatus(await request(
      '/reports/runs/'+pending.id+'/cancel',a,{method:'POST'}),200,'cancel queued job');
    assert.equal(cancelled.status,'cancelled');
    assert.equal((await processNextReport(a.tenant)).state,'idle',
      'cancelled work must not be claimed');
    expectStatus(await request('/reports/runs/'+pending.id+'/download',a),
      409,'cancelled job has no artifact');

    // A queued job loses authorization before rendering: no private bytes.
    const revoked=expectStatus(await request('/reports/runs',a,{
      method:'POST',body:runBody}),202,'enqueue before revocation');
    await owner.query("UPDATE report_templates SET is_active=false "+
      "WHERE id=$1 AND tenant_id=$2",[template.id,a.tenant]);
    const denied=await processNextReport(a.tenant);
    assert.equal(denied.id,revoked.id);
    assert.equal(denied.state,'failed','revoked template cannot render');
    assert.equal(denied.error_code,'AUTHORITY_REVOKED');
    const rejected=expectStatus(await request('/reports/runs/'+revoked.id,a),
      200,'observe safe failure code');
    assert.equal(rejected.status,'failed');
    assert.equal(rejected.error_code,'AUTHORITY_REVOKED');
    expectStatus(await request('/reports/runs/'+revoked.id+'/download',a),
      409,'revoked job has no private file');

    // A crashed worker's third expired lease must be terminal, not retried
    // forever or silently picked up by a different tenant.
    const exhausted=expectStatus(await request('/reports/runs',a,{
      method:'POST',body:runBody}),202,'enqueue exhausted lease candidate');
    await owner.query(
      "UPDATE report_runs SET status='running',attempt_count=3, "+
      "lease_token=$3,lease_expires_at=now()-interval '30 seconds' "+
      "WHERE tenant_id=$1 AND id=$2",
      [a.tenant,exhausted.id,randomUUID()]);
    assert.equal((await processNextReport(b.tenant)).state,'idle');
    assert.equal((await processNextReport(a.tenant)).state,'idle',
      'expired third lease becomes failed without another render');
    const finalLease=expectStatus(await request('/reports/runs/'+exhausted.id,a),
      200,'exhausted job must expose terminal result');
    assert.equal(finalLease.status,'failed');
    assert.equal(finalLease.error_code,'RETRY_EXHAUSTED');
    assert.equal(finalLease.attempt_count,3);
    expectStatus(await request('/reports/runs/'+exhausted.id+'/download',a),
      409,'exhausted lease has no artifact');

    // Expiration and purge are independent: first deny API, then delete bytes.
    await owner.query("UPDATE report_run_files SET expires_at=now()-interval '1 second' "+
      "WHERE tenant_id=$1 AND run_id=$2",[a.tenant,queued.id]);
    expectStatus(await request('/reports/runs/'+queued.id+'/download',a),
      410,'expired artifact cannot be returned');
    await purgeExpiredReportFiles(a.tenant);
    const left=await owner.query(
      'SELECT count(*)::integer AS n FROM report_run_files WHERE tenant_id=$1 AND run_id=$2',
      [a.tenant,queued.id]);
    assert.equal(left.rows[0].n,0,'expired content removed by worker');
  } finally {
    if(ownerReady) {
      try { await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])',[tenants]); }
      catch { /* disposable fixture cleanup best effort */ }
    }
    if(appReady)await app.end();
    if(ownerReady)await owner.end();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await sequelize.close();
  }
});
