// Real HTTP review-queue profiling in the existing Chromium/Express/PostGIS CI.
// NEVER point at VPS or a shared database. Synthetic data only; no PII,
// query strings, session cookies, tenant identifiers, cursors or SQL in logs.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform, totalmem } from 'node:os';

export const HTTP_LOAD_FLAG = 'I_ACCEPT_ONLY_GITHUB_DISPOSABLE_TEST_DATABASE';
export const HTTP_LOAD_SIZE = 5000;
export const HTTP_LOAD_SAMPLES = 7;
export const HTTP_LOAD_CASES = Object.freeze([
  { name: 'newest_all', query: { sort: 'newest' } },
  { name: 'no_report', query: { state: 'no_report' } },
  { name: 'blocked', query: { state: 'blocked' } },
  { name: 'human_review', query: { state: 'review' } },
  { name: 'closure', query: { state: 'closure' } },
  { name: 'type_application', query: { type: 'application' } },
  { name: 'priority_urgent', query: { priority: 'urgent', sort: 'priority_first' } },
  { name: 'due_overdue', query: { due: 'overdue', sort: 'due_first' } },
  { name: 'composed', query: { type: 'application', state: 'blocked',
    priority: 'urgent', due: 'overdue', sort: 'due_first' } }
]);

const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertHttpLoadConfig(env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' ||
      env.SEDEAGRO_HTTP_LOAD_PROBE !== HTTP_LOAD_FLAG) {
    throw new Error('BLOCKED: HTTP load allowed only in explicit disposable GitHub CI');
  }
  let urls;
  try {
    urls = [new URL(env.TEST_DATABASE_ADMIN_URL), new URL(env.TEST_DATABASE_APP_URL)];
  } catch { throw new Error('BLOCKED: both disposable database URLs are required'); }
  if (urls.some(url => !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) ||
      urls[0].pathname !== urls[1].pathname ||
      urls[0].username === urls[1].username) {
    throw new Error('BLOCKED: HTTP load requires two roles on the SAME loopback *_test database');
  }
  return true;
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || !values.length ||
      values.some(v => !Number.isFinite(v) || v < 0) ||
      !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error('Invalid real HTTP latency sample');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 1000) / 1000;
}

export function validateReviewPage(payload) {
  assert.ok(payload && Array.isArray(payload.data) &&
    payload.pagination && typeof payload.pagination === 'object',
    'Real API must return JSON data and pagination');
  assert.ok(payload.data.length <= 50 && payload.pagination.page_size === 50,
    'Review API page must be limited to 50');
  assert.equal(typeof payload.pagination.has_more, 'boolean');
  if (payload.pagination.has_more) {
    assert.equal(typeof payload.pagination.next_cursor, 'string');
    assert.ok(payload.pagination.next_cursor.length >= 35, 'Real signed cursor required');
    assert.equal(payload.data.length, 50, 'Full page is required before next cursor');
  } else assert.equal(payload.pagination.next_cursor, null);
  const ids = payload.data.map(item => item?.id);
  assert.ok(ids.every(id => typeof id === 'string' && validUuid.test(id)),
    'Every returned row must contain valid UUID');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate IDs in one page');
  return ids;
}

export function makeReviewUrl(base, filters, cursor = null) {
  if (base !== 'http://127.0.0.1:4177/api/v1/work-orders/review-queue') {
    throw new Error('BLOCKED: only local Chromium API proxy may be profiled');
  }
  const allowed = new Set(['state', 'type', 'sort', 'priority', 'due', 'q']);
  if (Object.keys(filters).some(k => !allowed.has(k) || typeof filters[k] !== 'string')) {
    throw new Error('BLOCKED: invalid HTTP review load filter');
  }
  const url = new URL(base);
  url.searchParams.set('q', 'PilotLoad');
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  if (cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length < 35)
      throw new Error('BLOCKED: missing real API signed cursor');
    url.searchParams.set('cursor', cursor);
  }
  return url.toString();
}

async function httpPage(page, tenant, filters, cursor = null) {
  const url = makeReviewUrl(
    'http://127.0.0.1:4177/api/v1/work-orders/review-queue', filters, cursor);
  const start = performance.now();
  const response = await page.request.get(url, {
    headers: { 'x-tenant-id': tenant },
    timeout: 25000
  });
  const json = await response.json().catch(() => null);
  const milliseconds = performance.now() - start;
  return { status: response.status(), json, milliseconds };
}

export async function runHttpReviewLoad({ admin, page, tenant, field, reviewer, submitter },
  env = process.env) {
  assertHttpLoadConfig(env);
  for (const value of [tenant, field, reviewer, submitter]) {
    assert.match(value, validUuid, 'Only known synthetic UUID fixtures may be used');
  }
  assert.notEqual(reviewer, submitter, 'Human review needs a different submitter');

  const info = (await admin.query(
    'SELECT current_database() AS db, inet_server_addr()::text AS server')).rows[0];
  assert.match(info.db, /(?:^|[_-])test(?:$|[_-])/i);
  // Tests use a loopback port-forward to the disposable CI PostGIS container.
  const prior = await admin.query(
    'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1 AND title LIKE $2',
    [tenant, 'PilotLoad %']);
  assert.equal(prior.rows[0].n, 0, 'An existing load fixture must not be reused');

  const seed = await admin.query([
    'INSERT INTO work_orders',
    '(tenant_id,field_id,requested_by,type,status,priority,due_at,title,created_at)',
    'SELECT $1::uuid,$2::uuid,$3::uuid,',
    "CASE WHEN g%4=0 THEN 'application' WHEN g%4=1 THEN 'sowing'",
    "WHEN g%4=2 THEN 'harvest' ELSE 'inspection' END,",
    "'in_progress',",
    "CASE WHEN g%6=0 THEN 'urgent' WHEN g%6=1 THEN 'high' ELSE 'normal' END,",
    "CASE WHEN g%5=0 THEN NULL WHEN g%5=1 THEN now()+interval '3 days'",
    "ELSE now()-interval '3 days' END,",
    "'PilotLoad '||lpad(g::text,5,'0'),",
    "now()-interval '1 hour' - g*interval '1 second'",
    'FROM generate_series(1,$4::integer) g'
  ].join(' '), [tenant, field, reviewer, HTTP_LOAD_SIZE]);
  assert.equal(seed.rowCount, HTTP_LOAD_SIZE);
  const reports = await admin.query([
    'INSERT INTO work_order_executions',
    '(tenant_id,work_order_id,submitted_by,started_at,finished_at,',
    'worked_area_hectares,result_summary,review_status,reviewed_by,reviewed_at)',
    'SELECT w.tenant_id,w.id,',
    'CASE WHEN right(w.title,5)::int%4=2 THEN $2::uuid ELSE $3::uuid END,',
    "now()-interval '4 hours',now()-interval '3 hours',",
    "2.00,'Synthetic HTTP request load result',",
    "CASE WHEN right(w.title,5)::int%4=3 THEN 'verified' ELSE 'submitted' END,",
    'CASE WHEN right(w.title,5)::int%4=3 THEN $2::uuid ELSE NULL END,',
    'CASE WHEN right(w.title,5)::int%4=3 THEN now() ELSE NULL END',
    'FROM work_orders w',
    "WHERE w.tenant_id=$1::uuid AND w.title LIKE 'PilotLoad %'",
    'AND right(w.title,5)::int%4<>0'
  ].join(' '), [tenant, reviewer, submitter]);
  assert.equal(reports.rowCount, HTTP_LOAD_SIZE * 3 / 4);
  // ANALYZE as database owner: update planner statistics after synthetic bulk
  // insert before applying real HTTP queries through restricted runtime role.
  await admin.query('ANALYZE work_orders');
  await admin.query('ANALYZE work_order_executions');
  console.log('REVIEW_HTTP_LOAD_ENV=' + JSON.stringify({
    os: platform(), arch: arch(), cpus: cpus().length,
    memoryMb: Math.round(totalmem()/1048576),
    node: process.version, postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
    scale: HTTP_LOAD_SIZE, executions: reports.rowCount, samples: HTTP_LOAD_SAMPLES,
    service: 'real Express via Vite loopback proxy and Chromium cookie session'
  }));
  for (const testCase of HTTP_LOAD_CASES) {
    const measurements = [];
    let firstIds = null;
    let firstPage = null;
    for (let i = 0; i < HTTP_LOAD_SAMPLES; i++) {
      const response = await httpPage(page, tenant, testCase.query);
      assert.equal(response.status, 200, 'Real HTTP query must succeed');
      const ids = validateReviewPage(response.json);
      assert.equal(ids.length, 50, 'Five-thousand-order fixture must produce full first page');
      assert.ok(response.json.data.every(row => row.title.startsWith('PilotLoad ')),
        'All returned records must belong to synthetic fixture');
      if (firstIds) assert.deepEqual(ids, firstIds,
        'Stable data must produce identical ordered page IDs across HTTP samples');
      else { firstIds = ids; firstPage = response.json; }
      measurements.push(response.milliseconds);
    }
    assert.ok(firstPage.pagination.has_more, 'Every tested filter must have 2+ pages');
    const next = await httpPage(page, tenant, testCase.query,
      firstPage.pagination.next_cursor);
    assert.equal(next.status, 200, 'Authenticated HMAC next page must load');
    const secondIds = validateReviewPage(next.json);
    assert.ok(secondIds.length > 0, 'Signed next page must contain records');
    assert.ok(secondIds.every(id => !firstIds.includes(id)),
      'Keyset pages may not repeat IDs');
    const own = await admin.query(
      "SELECT count(*)::int n FROM work_orders WHERE tenant_id=$1 AND title LIKE 'PilotLoad %' AND id=ANY($2::uuid[])",
      [tenant, [...firstIds, ...secondIds]]);
    assert.equal(own.rows[0].n, firstIds.length + secondIds.length,
      'Authenticated API must return own synthetic tenant rows only');

    console.log('REVIEW_HTTP_LOAD=' + JSON.stringify({
      scale: HTTP_LOAD_SIZE, scenario: testCase.name, samples: HTTP_LOAD_SAMPLES,
      p50Ms: percentile(measurements, .5), p95Ms: percentile(measurements, .95),
      p99Ms: percentile(measurements, .99),
      firstPageRows: firstIds.length, secondPageRows: secondIds.length,
      secondPageMs: Math.round(next.milliseconds * 1000) / 1000,
      orderStable: true, tenantIsolated: true
    }));
  }
  const initial = await httpPage(page, tenant, { sort:'newest' });
  assert.equal(initial.status, 200);
  const cursor = initial.json.pagination.next_cursor;
  assert.ok(cursor, 'Real signed cursor required to probe integrity');
  const modified = await httpPage(page, tenant, {sort:'newest'}, cursor + 'x');
  assert.equal(modified.status, 422, 'Modified signed cursor must be rejected');
  assert.equal(modified.json?.error?.code, 'ORDER_REVIEW_CURSOR_INVALID');
  const replay = await httpPage(page, tenant, {sort:'due_first'}, cursor);
  assert.equal(replay.status, 422, 'Signed cursor cannot be replayed with another sort');
  assert.equal(replay.json?.error?.code, 'ORDER_REVIEW_CURSOR_INVALID');
  console.log('PASS: 5000 synthetic orders, nine real HTTP filters, repeated p50/p95/p99, stable signed next page, tamper/replay 422, tenant isolation.');
}
