// Real PostgreSQL/PostGIS performance evidence for the review-queue state SQL.
// CI-ONLY: synthetic tenants in disposable *_test DB, FORCE RLS runtime role,
// EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON). No PII, SQL text, UUIDs or URLs logged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isSafeRuntimeDbRole } from '../backend/src/core/tenantDbSafety.js';
import { REVIEW_QUEUE_STATE_GROUPS, reviewQueueStateSql, reviewQueueFilterPredicateSql }
  from '../backend/src/modules/workOrders/reviewQueueStateSql.js';

const CASES = Object.freeze([
  { state: 'all', type: 'all' },
  { state: 'no_report', type: 'all' },
  { state: 'blocked', type: 'all' },
  { state: 'review', type: 'all' },
  { state: 'closure', type: 'all' },
  { state: 'all', type: 'application' },
  { state: 'no_report', type: 'application' },
  { state: 'blocked', type: 'sowing' },
  { state: 'review', type: 'harvest' },
  { state: 'closure', type: 'application' },
  { state: 'review', type: 'application' }
]);
const SIZES = Object.freeze([240, 1200]);
const SAMPLES = 7;
const flag = 'I_ACCEPT_DISPOSABLE_POSTGIS_PERF_ONLY';
let diagnosticPhase = 'preflight';
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertDisposablePerfConfig(env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' ||
      env.SEDEAGRO_PERF_PROBE !== flag) {
    throw new Error('BLOCKED: real performance probes require explicitly authorized disposable GitHub CI');
  }
  const values = [env.TEST_DATABASE_ADMIN_URL, env.TEST_DATABASE_APP_URL];
  if (values.some(value => typeof value !== 'string' || !value)) {
    throw new Error('BLOCKED: two isolated test PostgreSQL URLs required');
  }
  let parsed;
  try { parsed = values.map(value => new URL(value)); }
  catch { throw new Error('BLOCKED: malformed test database URL'); }
  if (parsed.some(url => url.protocol !== 'postgres:' &&
      url.protocol !== 'postgresql:') ||
      parsed.some(url => !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
      parsed.some(url => !/(?:^|[_-])test(?:$|[_-])/i.test(
        decodeURIComponent(url.pathname.slice(1)))) ||
      parsed[0].pathname !== parsed[1].pathname ||
      parsed[0].username === parsed[1].username) {
    throw new Error('BLOCKED: performance probe only accepts same local disposable *_test database and distinct roles');
  }
  return { adminUrl: values[0], appUrl: values[1] };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || !values.length ||
      values.some(n => !Number.isFinite(n) || n < 0) ||
      !(fraction > 0 && fraction <= 1)) throw new Error('Invalid benchmark sample');
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(ordered.length * fraction) - 1] * 1000) / 1000;
}

export function buildProbeQuery(reviewerId, state, mode = 'baseline') {
  if (!uuidRe.test(reviewerId) || !Object.hasOwn(REVIEW_QUEUE_STATE_GROUPS, state) ||
      !['baseline', 'optimized'].includes(mode)) {
    throw new Error('Unrecognized review performance probe');
  }
  const selected = REVIEW_QUEUE_STATE_GROUPS[state];
  const predicate = selected === null ? '' : mode === 'baseline'
    ? ' AND ' + reviewQueueStateSql(reviewerId) + ' = ANY($3::text[])'
    : ' AND (' + reviewQueueFilterPredicateSql(reviewerId, state) + ')';
  // Fixed sort/limit and same production state projection or optimized predicate.
  return [
    'SELECT "WorkOrder".id, "WorkOrder".created_at',
    'FROM work_orders AS "WorkOrder"',
    'WHERE "WorkOrder".tenant_id = $1::uuid',
    "AND \"WorkOrder\".status = 'in_progress'",
    'AND "WorkOrder".created_at <= now()',
    "AND ($2::text = 'all' OR \"WorkOrder\".type = $2::text)",
    predicate,
    "ORDER BY date_trunc('milliseconds', \"WorkOrder\".created_at) DESC,",
    '"WorkOrder".id DESC LIMIT 51'
  ].join(' ');
}

export function buildProbeParams(fixture, testCase, mode = 'baseline') {
  if (!['baseline', 'optimized'].includes(mode) ||
      !Object.hasOwn(REVIEW_QUEUE_STATE_GROUPS, testCase.state)) {
    throw new Error('Unrecognized review performance parameters');
  }
  const params = [fixture.tenant, testCase.type];
  if (mode === 'baseline' && testCase.state !== 'all') {
    params.push(REVIEW_QUEUE_STATE_GROUPS[testCase.state]);
  }
  return params;
}

export function buildProbeSql(reviewerId, state, mode = 'baseline') {
  return 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' +
    buildProbeQuery(reviewerId, state, mode);
}

export function summarizeExplain(explainValue) {
  const payload = typeof explainValue === 'string' ? JSON.parse(explainValue) : explainValue;
  const report = payload?.[0];
  const plan = report?.Plan;
  if (!plan || !Number.isFinite(report['Execution Time']) ||
      !Number.isFinite(report['Planning Time']) ||
      !Number.isFinite(plan['Actual Rows']) ||
      !Number.isFinite(plan['Actual Loops'])) {
    throw new Error('BLOCKED: PostgreSQL did not return a complete analyzed query plan');
  }
  const nodeCounts = new Map();
  let maxLoops = 0;
  let nodeCount = 0;
  function walk(node) {
    if (!node || typeof node['Node Type'] !== 'string') {
      throw new Error('BLOCKED: malformed PostgreSQL plan node');
    }
    nodeCount += 1;
    if (nodeCount > 500) throw new Error('BLOCKED: excessive planner structure');
    const type = node['Node Type'];
    nodeCounts.set(type, (nodeCounts.get(type) || 0) + 1);
    maxLoops = Math.max(maxLoops, node['Actual Loops'] || 0);
    for (const child of node.Plans || []) walk(child);
  }
  walk(plan);
  return {
    executionMs: report['Execution Time'],
    planningMs: report['Planning Time'],
    returnedRows: plan['Actual Rows'],
    nodeCount, maxLoops,
    sharedHitBlocks: plan['Shared Hit Blocks'] || 0,
    sharedReadBlocks: plan['Shared Read Blocks'] || 0,
    tempReadBlocks: plan['Temp Read Blocks'] || 0,
    tempWrittenBlocks: plan['Temp Written Blocks'] || 0,
    planNodes: Object.fromEntries([...nodeCounts].sort(([a], [b]) => a.localeCompare(b)))
  };
}

async function seedScale(admin, { tenant, field, reviewer, submitter }, start, stop) {
  const args = [tenant, field, start, stop];
  await admin.query([
    'INSERT INTO work_orders (tenant_id,field_id,type,status,priority,title,created_at)',
    "SELECT $1::uuid,$2::uuid,CASE (n%3) WHEN 0 THEN 'application'",
    "WHEN 1 THEN 'sowing' ELSE 'harvest' END,'in_progress','normal',",
    "'CI synthetic review '||lpad(n::text,5,'0'), now() - n * interval '1 second'",
    'FROM generate_series($3::int,$4::int) AS n'
  ].join(' '), args);
  await admin.query([
    'INSERT INTO work_order_executions',
    '(tenant_id,work_order_id,submitted_by,started_at,finished_at,',
    'worked_area_hectares,result_summary,review_status,reviewed_by,reviewed_at)',
    'SELECT wo.tenant_id,wo.id,',
    'CASE WHEN right(wo.title,5)::int%4=2 THEN $5::uuid ELSE $6::uuid END,',
    "now()-interval '3 hours',now()-interval '2 hours',",
    "2.00,'Synthetic fixture report for PostgreSQL review benchmark',",
    "CASE WHEN right(wo.title,5)::int%4=1 THEN 'verified' ELSE 'submitted' END,",
    'CASE WHEN right(wo.title,5)::int%4=1 THEN $5::uuid ELSE NULL END,',
    'CASE WHEN right(wo.title,5)::int%4=1 THEN now() ELSE NULL END',
    'FROM work_orders wo WHERE wo.tenant_id=$1::uuid AND wo.field_id=$2::uuid',
    'AND right(wo.title,5)::int BETWEEN $3::int AND $4::int',
    'AND right(wo.title,5)::int%4<>0'
  ].join(' '), [...args, reviewer, submitter]);
  // Rejected-only history remains awaiting_report: the live report projection
  // intentionally ignores rejected rows. Preserve this boundary in parity.
  await admin.query([
    'INSERT INTO work_order_executions',
    '(tenant_id,work_order_id,submitted_by,started_at,finished_at,',
    'worked_area_hectares,result_summary,review_status,reviewed_by,reviewed_at,review_note)',
    "SELECT wo.tenant_id,wo.id,$6::uuid,now()-interval '3 hours',",
    "now()-interval '2 hours',2.00,",
    "'Synthetic rejected-only historical report for SQL parity',",
    "'rejected',$5::uuid,now(),'Synthetic rejection before resubmission'",
    'FROM work_orders wo WHERE wo.tenant_id=$1::uuid AND wo.field_id=$2::uuid',
    'AND right(wo.title,5)::int BETWEEN $3::int AND $4::int',
    'AND right(wo.title,5)::int%8=0'
  ].join(' '), [...args, reviewer, submitter]);
  // The human-review branch for application orders requires real evidence.
  await admin.query([
    'INSERT INTO evidence_assets',
    '(tenant_id,work_order_id,work_order_execution_id,kind,storage_key,uploaded_by)',
    "SELECT wo.tenant_id,wo.id,r.id,'document','ci-perf/'||r.id,$5::uuid",
    'FROM work_orders wo JOIN work_order_executions r',
    'ON r.tenant_id=wo.tenant_id AND r.work_order_id=wo.id',
    'WHERE wo.tenant_id=$1::uuid AND wo.field_id=$2::uuid AND wo.type=\'application\'',
    'AND right(wo.title,5)::int BETWEEN $3::int AND $4::int',
    'AND right(wo.title,5)::int%4=3'
  ].join(' '), [...args, submitter]);
}

async function createFixture(admin) {
  const random = randomUUID().slice(0, 12);
  const [plan] = (await admin.query("SELECT id FROM plans WHERE code='starter'")).rows;
  assert.ok(plan, 'Migrations and global seeds are mandatory');
  const tenants = [];
  const users = [];
  try {
    for (const label of ['a', 'b']) {
      const { rows: [tenant] } = await admin.query([
        'INSERT INTO tenants(name,slug,plan_id,status)',
        "VALUES ($1,$2,$3,'active') RETURNING id"
      ].join(' '), ['CI Performance ' + label, 'perf-' + label + '-' + random, plan.id]);
      tenants.push(tenant.id);
    }
    for (const label of ['reviewer', 'submitter']) {
      const { rows: [user] } = await admin.query([
        'INSERT INTO users(email,password_hash,full_name)',
        'VALUES ($1,$2,$3) RETURNING id'
      ].join(' '), [label + '-perf-' + random + '@example.test',
        'ci-noninteractive-fixture', 'Synthetic ' + label]);
      users.push(user.id);
      await admin.query([
        'INSERT INTO memberships(tenant_id,user_id,role_code,status)',
        "VALUES ($1,$2,'tenant_admin','active')"
      ].join(' '), [tenants[0], user.id]);
    }
    // A second independent tenant exercises FORCE RLS rather than assumed filtering.
    await admin.query([
      'INSERT INTO memberships(tenant_id,user_id,role_code,status)',
      "VALUES ($1,$2,'tenant_admin','active')"
    ].join(' '), [tenants[1], users[0]]);
    const fields = [];
    for (const label of [0, 1]) {
      const { rows: [farm] } = await admin.query(
        'INSERT INTO farms(tenant_id,name) VALUES($1,$2) RETURNING id',
        [tenants[label], 'Synthetic performance farm ' + random]);
      const { rows: [field] } = await admin.query(
        'INSERT INTO fields(tenant_id,farm_id,name) VALUES($1,$2,$3) RETURNING id',
        [tenants[label], farm.id, 'Synthetic field']);
      fields.push(field.id);
    }
    await admin.query([
      'INSERT INTO work_orders(tenant_id,field_id,type,status,title)',
      "SELECT $1::uuid,$2::uuid,'sowing','in_progress','CI other-tenant '||n",
      'FROM generate_series(1,36) n'
    ].join(' '), [tenants[1], fields[1]]);
    return { tenant: tenants[0], otherTenant: tenants[1], field: fields[0],
      reviewer: users[0], submitter: users[1], tenants, users };
  } catch (error) {
    for (const tenant of tenants) {
      await admin.query('DELETE FROM tenants WHERE id=$1', [tenant]).catch(() => {});
    }
    for (const user of users) {
      await admin.query('DELETE FROM users WHERE id=$1', [user]).catch(() => {});
    }
    throw error;
  }
}

async function measure(app, fixture, scale) {
  diagnosticPhase = 'runtime-rls-' + scale;
  await app.query('BEGIN READ ONLY');
  try {
    await app.query("SELECT set_config('app.current_tenant',$1,true)", [fixture.tenant]);
    await app.query("SET LOCAL statement_timeout = '10000ms'");
    const { rows: [visible] } = await app.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [fixture.tenant]);
    assert.equal(visible.n, scale, 'Runtime RLS must see exactly the synthetic target scale');
    const { rows: [invisible] } = await app.query(
      'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1', [fixture.otherTenant]);
    assert.equal(invisible.n, 0, 'A foreign tenant cannot leak through the benchmark role');
    console.log('PERF_SANITY=' + JSON.stringify({ scale, ownRows: visible.n, foreignRows: invisible.n }));
    for (const testCase of CASES) {
      diagnosticPhase = 'explain-' + scale + '-' + testCase.state + '-' + testCase.type;
      const snapshots = {};
      for (const mode of ['baseline', 'optimized']) {
        diagnosticPhase = 'parity-' + scale + '-' + testCase.state + '-' + testCase.type + '-' + mode;
        const expected = await app.query(
          buildProbeQuery(fixture.reviewer, testCase.state, mode),
          buildProbeParams(fixture, testCase, mode));
        snapshots[mode] = expected.rows.map(row => row.id);
      }
      assert.deepEqual(snapshots.optimized, snapshots.baseline,
        'Optimized review filter must return identical ordered page IDs');
      for (const mode of ['baseline', 'optimized']) {
        diagnosticPhase = 'explain-' + scale + '-' + testCase.state + '-' + testCase.type + '-' + mode;
        const parameters = buildProbeParams(fixture, testCase, mode);
        const sql = buildProbeSql(fixture.reviewer, testCase.state, mode);
        const serverTimes = [];
        const clientTimes = [];
        const plans = [];
        for (let repeat = 0; repeat < SAMPLES; repeat += 1) {
          const started = performance.now();
          const result = await app.query(sql, parameters);
          clientTimes.push(performance.now() - started);
          assert.equal(result.rows.length, 1, 'Postgres EXPLAIN must return exactly one JSON plan row');
          const stats = summarizeExplain(result.rows[0]['QUERY PLAN']);
          assert.ok(stats.returnedRows >= 0 && stats.returnedRows <= 51);
          assert.ok(stats.executionMs >= 0 && stats.planningMs >= 0);
          serverTimes.push(stats.executionMs);
          plans.push(stats);
        }
        const last = plans.at(-1);
        console.log('REVIEW_QUEUE_PG_PERF=' + JSON.stringify({
          scale, state: testCase.state, type: testCase.type, mode,
          parity: true, samples: SAMPLES,
          serverP50Ms: percentile(serverTimes, .5),
          serverP95Ms: percentile(serverTimes, .95),
          clientP50Ms: percentile(clientTimes, .5),
          clientP95Ms: percentile(clientTimes, .95),
          returnedRows: last.returnedRows,
          maxPlanLoops: Math.max(...plans.map(p => p.maxLoops)),
          maxSharedHitBlocks: Math.max(...plans.map(p => p.sharedHitBlocks)),
          maxSharedReadBlocks: Math.max(...plans.map(p => p.sharedReadBlocks)),
          maxTempWrittenBlocks: Math.max(...plans.map(p => p.tempWrittenBlocks)),
          planNodes: last.planNodes
        }));
      }
    }
    await app.query('COMMIT');
  } catch (error) {
    await app.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function main(env = process.env) {
  const { adminUrl, appUrl } = assertDisposablePerfConfig(env);
  const admin = new pg.Client({ connectionString: adminUrl });
  const app = new pg.Client({ connectionString: appUrl });
  let connectedAdmin = false, connectedApp = false, fixture;
  try {
    await admin.connect(); connectedAdmin = true;
    await app.connect(); connectedApp = true;
    const dbName = (await admin.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(dbName, /(?:^|[_-])test(?:$|[_-])/i);
    const runtimeDb = (await app.query('SELECT current_database() AS db')).rows[0].db;
    assert.equal(dbName, runtimeDb, 'Admin and RLS app roles must use the same disposable DB');
    const role = (await app.query([
      'SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,',
      'pg_get_userbyid(d.datdba) AS db_owner FROM pg_roles r',
      'JOIN pg_database d ON d.datname=current_database()',
      'WHERE r.rolname=current_user'
    ].join(' '))).rows[0];
    assert.ok(isSafeRuntimeDbRole(role), 'Privileged DB roles cannot profile RLS queries');
    const pgVersion = (await app.query('SHOW server_version')).rows[0].server_version;
    console.log('REVIEW_QUEUE_PG_ENV=' + JSON.stringify({
      os: platform(), arch: arch(), logicalCpus: cpus().length,
      systemMemoryMb: Math.round(totalmem() / 1048576),
      nodeVersion: process.version, postgresVersion: pgVersion,
      samplesPerCase: SAMPLES, scales: SIZES
    }));
    diagnosticPhase = 'synthetic-fixtures';
    fixture = await createFixture(admin);
    let prior = 0;
    for (const scale of SIZES) {
      diagnosticPhase = 'seed-' + scale;
      await seedScale(admin, fixture, prior + 1, scale);
      await admin.query('ANALYZE work_orders');
      await admin.query('ANALYZE work_order_executions');
      await admin.query('ANALYZE evidence_assets');
      await measure(app, fixture, scale);
      prior = scale;
    }
    diagnosticPhase = 'rls-reset';
    await app.query('SELECT count(*)::int AS n FROM work_orders')
      .then(({ rows }) => assert.equal(rows[0].n, 0,
        'Runtime tenant transaction setting must clear after COMMIT'));
    console.log('PASS: baseline and optimized pages agree exactly under FORCE RLS at both scales; measured plans, no production SLO inferred');
  } finally {
    if (connectedApp) {
      await app.query('ROLLBACK').catch(() => {});
      await app.end().catch(() => {});
    }
    if (connectedAdmin) {
      try {
        if (fixture) {
          for (const tenant of fixture.tenants) {
            await admin.query('DELETE FROM tenants WHERE id=$1', [tenant]);
          }
          for (const user of fixture.users) {
            await admin.query('DELETE FROM users WHERE id=$1', [user]);
          }
        }
      } finally { await admin.end().catch(() => {}); }
    }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    // SQL driver stack traces may contain fixture values. Only sanitized error code.
    console.error('BLOCKED: review queue PostGIS performance evidence incomplete [' +
      diagnosticPhase.replace(/[^a-z0-9-]/g, '') + ']: ' +
      String(error?.code || error?.name || 'UNKNOWN').replace(/[^A-Z_a-z0-9]/g, ''));
    process.exitCode = 1;
  });
}
