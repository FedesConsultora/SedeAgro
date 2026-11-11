// RP-02: true worker SIGKILL, lease expiry and recovery with disposable PostGIS.
// Kept outside test/*.pg.mjs: CI executes this serially after concurrent tests
// because a short-lived ACCESS EXCLUSIVE lock pauses report-template reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inspectReportWorkerHealth } from '../../src/workers/reportWorkerHealth.js';

const ownerUrl=process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl=process.env.TEST_DATABASE_APP_URL;
const disposable=value=>{
  try {
    const url=new URL(value);
    return ['postgres:','postgresql:'].includes(url.protocol) &&
      /(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)));
  } catch { return false; }
};
if(!disposable(ownerUrl)||!disposable(runtimeUrl)){
  throw new Error('Only disposable *_test PostGIS owner/runtime connections are allowed');
}
const workerCli=fileURLToPath(new URL('../../src/workers/reportWorkerCli.js',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function startWorker(tenantId,{once=true}={}){
  const {TEST_DATABASE_ADMIN_URL:_owner,TEST_DATABASE_APP_URL:_app,
    DATABASE_URL:_db,REPORT_WORKER_TENANT_ID:_tenant,...inherited}=process.env;
  const child=spawn(process.execPath,[workerCli,...(once?['--once']:[])],{
    env:{...inherited,DATABASE_URL:runtimeUrl,REPORT_WORKER_TENANT_ID:tenantId,
      NODE_ENV:'test',JWT_SECRET:'rp02-disposable-crash-only',
      LOG_SQL:'0',LOG_STACK:'0',LOG_FORMAT:'json',LOG_LEVEL:'info'},
    stdio:['ignore','pipe','pipe'],shell:false
  });
  let stdout='',stderr='',overflow=false,timedOut=false;
  const cap=48*1024;
  child.stdout.on('data',chunk=>{
    stdout+=chunk.toString('utf8');
    if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>cap){
      overflow=true;child.kill('SIGKILL');
    }
  });
  child.stderr.on('data',chunk=>{
    stderr+=chunk.toString('utf8');
    if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>cap){
      overflow=true;child.kill('SIGKILL');
    }
  });
  const exited=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},16000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
  return {child,exited,logs(){
    assert.equal(timedOut,false,'worker process hung');
    assert.equal(overflow,false,'worker logs overflow');
    assert.equal(stderr,'','unexpected worker stderr');
    return stdout.trim().split('\n').filter(Boolean).map(line=>{
      try{return JSON.parse(line);}catch{assert.fail('worker emitted invalid JSON logs');}
    });
  }};
}

test('RP-02 real SIGKILL -> stale lease -> new worker process completes one private file', {timeout:45000},async()=>{
  const owner=new pg.Client({connectionString:ownerUrl});
  const blocker=new pg.Client({connectionString:ownerUrl});
  const runtime=new pg.Client({connectionString:runtimeUrl});
  let ownerReady=false,blockerReady=false,runtimeReady=false,locked=false,tenantId;
  const live=new Set();
  try{
    await owner.connect();ownerReady=true;
    await blocker.connect();blockerReady=true;
    await runtime.connect();runtimeReady=true;
    const db=(await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i);
    const role=(await runtime.query('SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole, '+
      'r.rolname AS role,pg_get_userbyid(d.datdba) AS db_owner '+
      'FROM pg_roles r JOIN pg_database d ON d.datname=current_database() '+
      'WHERE r.rolname=current_user')).rows[0];
    assert.ok(role && !role.rolsuper && !role.rolbypassrls &&
      !role.rolcreatedb && !role.rolcreaterole && role.role!==role.db_owner);
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const suffix=randomUUID().replaceAll('-','').slice(0,12);
    tenantId=(await owner.query(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES ($1,'Recovery probe',$2,'active') RETURNING id",
      [plan.id,'rp02-crash-'+suffix])).rows[0].id;
    const userId=(await owner.query(
      "INSERT INTO users(full_name,email,password_hash) VALUES ('Recovery admin',$1,'fixture') RETURNING id",
      ['rp02-crash-'+suffix+'@example.test'])).rows[0].id;
    await owner.query("INSERT INTO memberships(tenant_id,user_id,role_code,status) "+
      "VALUES ($1,$2,'tenant_admin','active')",[tenantId,userId]);
    await owner.query("INSERT INTO tenant_modules(tenant_id,module_code,is_enabled,source) "+
      "VALUES ($1,'reports',true,'plan')",[tenantId]);
    const farm=(await owner.query(
      "INSERT INTO farms(tenant_id,name) VALUES ($1,'Recovery farm') RETURNING id",
      [tenantId])).rows[0].id;
    const field=(await owner.query(
      "INSERT INTO fields(tenant_id,farm_id,name) VALUES ($1,$2,'Recovered field') RETURNING id",
      [tenantId,farm])).rows[0].id;
    const template=(await owner.query(
      "INSERT INTO report_templates(tenant_id,name,code,scope,format) "+
      "VALUES ($1,'Recovery report','rp02-recovery','field','csv') RETURNING id",
      [tenantId])).rows[0].id;
    const jobId=(await owner.query(
      "INSERT INTO report_runs(tenant_id,report_template_id,requested_by,status,filters) "+
      "VALUES ($1,$2,$3,'queued',$4::jsonb) RETURNING id",
      [tenantId,template,userId,JSON.stringify({field_id:field})])).rows[0].id;

    // Only the dedicated serial CI test takes this short lock. The worker
    // claims & commits the report, then blocks reading report_templates.
    // No test-only hooks or alternate worker implementation are introduced.
    await blocker.query('BEGIN');locked=true;
    await blocker.query('LOCK TABLE report_templates IN ACCESS EXCLUSIVE MODE');
    const first=startWorker(tenantId);live.add(first);
    let claimed=null;
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      const row=(await owner.query(
        'SELECT status,attempt_count,lease_token,lease_expires_at FROM report_runs '+
        'WHERE tenant_id=$1 AND id=$2',[tenantId,jobId])).rows[0];
      if(row?.status==='running' && row.lease_token){claimed=row;break;}
      if(first.child.exitCode!==null)break;
      await pause(80);
    }
    assert.ok(claimed,'worker must claim before crash');
    assert.equal(claimed.attempt_count,1);
    assert.ok(claimed.lease_expires_at);
    assert.equal(first.child.kill('SIGKILL'),true);
    const killed=await first.exited;
    assert.equal(killed.signal,'SIGKILL');
    assert.equal(killed.code,null);
    first.logs();live.delete(first);
    await blocker.query('ROLLBACK');locked=false;
    const still=(await owner.query(
      'SELECT status,attempt_count,lease_token FROM report_runs WHERE tenant_id=$1 AND id=$2',
      [tenantId,jobId])).rows[0];
    assert.equal(still.status,'running');
    assert.equal(still.attempt_count,1);
    assert.equal(still.lease_token,claimed.lease_token);
    const fileCount=()=>owner.query(
      'SELECT count(*)::integer AS n FROM report_run_files WHERE tenant_id=$1 AND run_id=$2',
      [tenantId,jobId]).then(v=>v.rows[0].n);
    assert.equal(await fileCount(),0,'crashed worker must leave no bytes');

    // Simulate only the 120s TTL in this disposable fixture, not prod settings.
    await owner.query("UPDATE report_runs SET lease_expires_at=now()-interval '30 seconds' "+
      "WHERE tenant_id=$1 AND id=$2 AND status='running'",[tenantId,jobId]);
    await owner.query("UPDATE report_worker_presence SET last_seen_at=now()-interval '30 seconds' "+
      "WHERE tenant_id=$1",[tenantId]);
    const stale=await inspectReportWorkerHealth(runtime,tenantId);
    assert.equal(stale.status,'critical');
    assert.ok(stale.reason_codes.includes('HEARTBEAT_STALE'));
    assert.ok(stale.reason_codes.includes('LEASE_OVERDUE'));
    assert.equal(stale.metrics.overdue_lease_count,1);

    const restarted=startWorker(tenantId);live.add(restarted);
    assert.deepEqual(await restarted.exited,{code:0,signal:null});
    const events=restarted.logs().filter(x=>x.event==='report_worker_job');
    assert.equal(events.length,1);
    assert.deepEqual({
      state:events[0].state,run_id:events[0].run_id,error_code:events[0].error_code
    },{state:'completed',run_id:jobId,error_code:null});
    live.delete(restarted);
    const final=(await owner.query(
      'SELECT r.status,r.attempt_count,r.lease_token,r.lease_expires_at, '+
      'count(f.run_id)::integer AS file_count,max(f.sha256) AS hash, '+
      "max(encode(f.content,'base64')) AS file,max(octet_length(f.content))::integer AS bytes "+
      'FROM report_runs r LEFT JOIN report_run_files f ON f.run_id=r.id AND f.tenant_id=r.tenant_id '+
      'WHERE r.tenant_id=$1 AND r.id=$2 GROUP BY r.id',
      [tenantId,jobId])).rows[0];
    assert.equal(final.status,'completed');
    assert.equal(final.attempt_count,2);
    assert.equal(final.lease_token,null);
    assert.equal(final.lease_expires_at,null);
    assert.equal(final.file_count,1,'no duplicate file on recovery');
    const bytes=Buffer.from(final.file,'base64');
    assert.equal(bytes.length,final.bytes);
    assert.ok(bytes.toString('utf8').includes('Recovered field'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),final.hash);
    const healthy=await inspectReportWorkerHealth(runtime,tenantId);
    assert.equal(healthy.status,'healthy');
    assert.equal(healthy.metrics.running_count,0);
    assert.equal(healthy.metrics.overdue_lease_count,0);
    const third=startWorker(tenantId);live.add(third);
    assert.deepEqual(await third.exited,{code:0,signal:null});
    assert.equal(third.logs().filter(x=>x.event==='report_worker_job').length,0);
    live.delete(third);
    assert.equal(await fileCount(),1,'restarting again cannot duplicate private bytes');

    // A supervisor stop must release the long-running worker cleanly, without
    // a SIGKILL or an extra claim. A new heartbeat proves it actually started.
    const heartbeatBefore=(await owner.query(
      'SELECT last_seen_at FROM report_worker_presence WHERE tenant_id=$1',
      [tenantId])).rows[0].last_seen_at;
    const continuous=startWorker(tenantId,{once:false});live.add(continuous);
    let observed=false;
    const readyUntil=Date.now()+9000;
    while(Date.now()<readyUntil){
      const seen=(await owner.query(
        'SELECT last_seen_at FROM report_worker_presence WHERE tenant_id=$1',
        [tenantId])).rows[0]?.last_seen_at;
      if(seen && new Date(seen)>new Date(heartbeatBefore)){observed=true;break;}
      if(continuous.child.exitCode!==null)break;
      await pause(90);
    }
    assert.ok(observed,'long-running worker never published heartbeat');
    assert.equal(continuous.child.kill('SIGTERM'),true);
    assert.deepEqual(await continuous.exited,{code:0,signal:null},
      'SIGTERM must stop worker gracefully and close DB connections');
    assert.equal(continuous.logs().filter(x=>x.event==='report_worker_job').length,0);
    live.delete(continuous);
    assert.equal(await fileCount(),1,'clean shutdown must not create other files');

  } finally {
    for(const p of live){
      if(p.child.exitCode===null)p.child.kill('SIGKILL');
      try{await p.exited;}catch{}
    }
    if(locked && blockerReady)try{await blocker.query('ROLLBACK');}catch{}
    if(ownerReady && tenantId)try{
      await owner.query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    }catch{}
    if(runtimeReady)await runtime.end();
    if(blockerReady)await blocker.end();
    if(ownerReady)await owner.end();
  }
});
