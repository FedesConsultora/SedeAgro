import test from 'node:test';
import assert from 'node:assert/strict';
import { startReportWorkerHeartbeat } from '../src/workers/reportWorkerHeartbeat.js';
import { classifyReportWorkerHealth, inspectReportWorkerHealth } from '../src/workers/reportWorkerHealth.js';

const fresh = () => ({
  heartbeat_age_seconds: 4.9,
  queued_count: 0,
  oldest_ready_age_seconds: null,
  running_count: 0,
  overdue_lease_count: 0,
  recent_failed_count: 0
});

test('fresh idle worker is healthy, no missing-queue false positives', () => {
  assert.deepEqual(classifyReportWorkerHealth(fresh()), {
    status: 'healthy', reason_codes: [], metrics: { ...fresh(), heartbeat_age_seconds: 4 }
  });
});

test('missing or stale heartbeat, expired leases, overdue queue fail closed', () => {
  for (const [patch, code] of [
    [{ heartbeat_age_seconds: null }, 'HEARTBEAT_MISSING'],
    [{ heartbeat_age_seconds: 20 }, 'HEARTBEAT_STALE'],
    [{ overdue_lease_count: 1 }, 'LEASE_OVERDUE'],
    [{ oldest_ready_age_seconds: 301 }, 'QUEUE_STALLED'],
    [{ running_count: 3 }, 'RUNNING_OVER_CAPACITY']
  ]) {
    const result = classifyReportWorkerHealth({ ...fresh(), ...patch });
    assert.equal(result.status, 'critical');
    assert.ok(result.reason_codes.includes(code));
  }
});

test('moderate delays, failures and capacity are warnings, not silently healthy', () => {
  const result = classifyReportWorkerHealth({ ...fresh(),
    queued_count: 10, oldest_ready_age_seconds: 120,
    recent_failed_count: 2
  });
  assert.equal(result.status, 'warning');
  assert.deepEqual(result.reason_codes, ['QUEUE_DELAYED', 'RECENT_FAILURES', 'QUEUE_AT_CAPACITY']);
});

test('unexpected or missing metrics fail closed, no permissive coercion', () => {
  for (const patch of [
    { queued_count: undefined }, { running_count: -1 },
    { recent_failed_count: '0' }, { overdue_lease_count: Infinity },
    { heartbeat_age_seconds: undefined }, { heartbeat_age_seconds: -1 },
    { oldest_ready_age_seconds: NaN }
  ]) assert.throws(() => classifyReportWorkerHealth({ ...fresh(), ...patch }));
});

test('inspect uses actual safe role and tenant-local read-only transaction', async () => {
  const statements = [];
  const tenant = '0a000000-0000-4000-8000-000000000001';
  const client = { async query(sql, params) {
    statements.push([sql, params]);
    if (sql.includes('FROM pg_roles')) return { rows: [{
      rolname: 'sedeagro_app', db_owner: 'sedeagro_owner',
      rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false
    }] };
    if (sql.includes('FROM report_runs r')) return { rows: [fresh()] };
    return { rows: [] };
  } };
  const result = await inspectReportWorkerHealth(client, tenant);
  assert.equal(result.status, 'healthy');
  assert.equal(statements[1][0], 'BEGIN READ ONLY');
  assert.deepEqual(statements[2][1], [tenant]);
  assert.deepEqual(statements[3][1], [tenant]);
  assert.equal(statements.at(-1)[0], 'ROLLBACK');
  assert.doesNotMatch(statements[3][0], /SELECT\s+\*/i);
});

test('inspection blocks owner roles, bad tenant and rolls back on SQL error', async () => {
  const tenant = '0a000000-0000-4000-8000-000000000001';
  let rolledBack = 0;
  let queryCount = 0;
  const client = { async query(sql) {
    queryCount++;
    if (sql.includes('FROM pg_roles')) return { rows: [{
      rolname: 'sedeagro_owner', db_owner: 'sedeagro_owner',
      rolsuper: true, rolbypassrls: true, rolcreaterole: true, rolcreatedb: true
    }] };
  } };
  await assert.rejects(inspectReportWorkerHealth(client, tenant), /Unsafe runtime/);
  assert.equal(queryCount, 1);
  await assert.rejects(inspectReportWorkerHealth(client, 'all'), /canonical tenant UUID/);
  assert.equal(queryCount, 1);
  const appClient = {async query(sql) {
    if (sql.includes('FROM pg_roles')) return {rows:[{
      rolname:'app',db_owner:'owner',rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false
    }]};
    if(sql === 'ROLLBACK') {rolledBack++;return {rows:[]};}
    if(sql.includes('FROM report_runs r')) throw new Error('db outage');
    return {rows:[]};
  }};
  await assert.rejects(inspectReportWorkerHealth(appClient, tenant), /db outage/);
  assert.equal(rolledBack, 1);
});

test('periodic heartbeat continues during slow work without overlapping writes', async () => {
  let callback, cancelled = false, writes = 0, failures = [];
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const loop = startReportWorkerHeartbeat({
    write: async () => {writes++; if(writes === 1) await blocker;},
    onFailure: event => failures.push(event),
    schedule: fn => { callback = fn; return 123; },
    unschedule: handle => { assert.equal(handle, 123); cancelled = true; }
  });
  callback();
  callback();
  await Promise.resolve();
  assert.equal(writes, 1, 'overlapping ticks must not write twice');
  release();
  await loop.tick();
  callback();
  await loop.tick();
  assert.equal(writes, 2, 'subsequent tick renews after slow work');
  await loop.stop();
  assert.equal(cancelled, true);
  callback();
  assert.equal(writes, 2, 'stopped timers must not write');
  assert.deepEqual(failures, []);
});

test('failed heartbeat log uses fixed code and recovers after next success', async () => {
  let callback, count = 0;
  const events = [];
  const loop = startReportWorkerHeartbeat({
    write: async () => {if(++count < 3) throw Error('postgres://private-secret');},
    onFailure: item => events.push(item),
    schedule: fn => {callback = fn; return 1;}, unschedule: () => {}
  });
  callback();await loop.tick();
  callback();await loop.tick();
  callback();await loop.tick();
  assert.deepEqual(events, [
    {code:'HEARTBEAT_WRITE_FAILED',consecutiveFailures:1},
    {code:'HEARTBEAT_WRITE_FAILED',consecutiveFailures:2}
  ]);
  await loop.stop();
});
