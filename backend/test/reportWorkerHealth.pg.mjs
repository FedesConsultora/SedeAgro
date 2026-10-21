// End-to-end PostgreSQL FORCE RLS inspection on a migrated disposable *_test DB.
// No application or production databases may be passed to this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inspectReportWorkerHealth } from '../src/workers/reportWorkerHealth.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Disposable PostGIS test URLs required');
const { Client } = pg;

test('real non-owner role sees only its tenant worker health and fails on expired work', async t => {
  const owner = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: appUrl });
  let connectedOwner = false;
  let connectedRuntime = false;
  let a, b;
  try {
    await owner.connect();connectedOwner = true;
    const db = (await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i,
      'No probe fixture writes allowed outside a *_test database');
    const [plan] = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows;
    assert.ok(plan, 'Bootstrap must seed the starter plan');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    a = (await owner.query(
      "INSERT INTO tenants (plan_id,name,slug,status) VALUES ($1,'Health A',$2,'active') RETURNING id",
      [plan.id, `health-a-${suffix}`])).rows[0].id;
    b = (await owner.query(
      "INSERT INTO tenants (plan_id,name,slug,status) VALUES ($1,'Health B',$2,'active') RETURNING id",
      [plan.id, `health-b-${suffix}`])).rows[0].id;
    await owner.query(`INSERT INTO report_worker_presence (tenant_id,last_seen_at)
      VALUES ($1,now()),($2,now()-interval '2 minutes')`, [a,b]);
    await runtime.connect();connectedRuntime = true;

    const healthy = await inspectReportWorkerHealth(runtime,a);
    assert.equal(healthy.status,'healthy');
    assert.equal(healthy.metrics.queued_count,0);
    assert.equal(healthy.metrics.heartbeat_age_seconds < 20,true);
    const stale = await inspectReportWorkerHealth(runtime,b);
    assert.equal(stale.status,'critical');
    assert.ok(stale.reason_codes.includes('HEARTBEAT_STALE'));

    // Backlog/failed/lease data in tenant B MUST NOT change tenant A metrics.
    const templateB = (await owner.query(`INSERT INTO report_templates
      (tenant_id,name,code,scope,format) VALUES ($1,'CI Probe','probe','field','csv') RETURNING id`,[b])).rows[0].id;
    await owner.query(`INSERT INTO report_runs
      (tenant_id,report_template_id,status,created_at) VALUES
      ($1,$2,'queued',now()-interval '6 minutes'),
      ($1,$2,'failed',now())`, [b,templateB]);
    await owner.query(`INSERT INTO report_runs
      (tenant_id,report_template_id,status,lease_token,lease_expires_at) VALUES
      ($1,$2,'running',$3,now()-interval '30 seconds')`,[b,templateB,randomUUID()]);

    const stillHealthy = await inspectReportWorkerHealth(runtime,a);
    assert.equal(stillHealthy.status,'healthy','other tenant backlog must be invisible');
    assert.equal(stillHealthy.metrics.queued_count,0);
    assert.equal(stillHealthy.metrics.overdue_lease_count,0);
    assert.equal(stillHealthy.metrics.recent_failed_count,0);
    const failed = await inspectReportWorkerHealth(runtime,b);
    assert.equal(failed.status,'critical');
    assert.equal(failed.metrics.queued_count,1);
    assert.equal(failed.metrics.overdue_lease_count,1);
    assert.equal(failed.metrics.recent_failed_count,1);
    assert.ok(failed.reason_codes.includes('QUEUE_STALLED'));
    assert.ok(failed.reason_codes.includes('LEASE_OVERDUE'));

    // This guard should never permit schema-owner reads even with FORCE RLS.
    await assert.rejects(inspectReportWorkerHealth(owner,a), /Unsafe runtime role/);

    // Absence of heartbeat is a distinct critical result, not falsely healthy.
    const c = randomUUID();
    const missing = await inspectReportWorkerHealth(runtime,c);
    assert.equal(missing.status,'critical');
    assert.deepEqual(missing.reason_codes,['HEARTBEAT_MISSING']);
  } finally {
    if (connectedOwner && (a || b)) {
      try {await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])',[[a,b].filter(Boolean)]);} catch { /* fixture cleanup best-effort */ }
    }
    if (connectedRuntime) await runtime.end();
    if (connectedOwner) await owner.end();
  }
});
