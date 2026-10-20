import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDisposablePerfConfig, percentile, buildProbeSql, summarizeExplain
} from '../benchmark-review-queue.mjs';

const safe = {
  CI: 'true', GITHUB_ACTIONS: 'true',
  SEDEAGRO_PERF_PROBE: 'I_ACCEPT_DISPOSABLE_POSTGIS_PERF_ONLY',
  TEST_DATABASE_ADMIN_URL: 'postgres://sedeagro_owner:temp@127.0.0.1:5432/sedeagro_test',
  TEST_DATABASE_APP_URL: 'postgres://sedeagro_app:temp@127.0.0.1:5432/sedeagro_test'
};
const reviewer = '01234567-89ab-4cde-8f01-234567890abc';

test('requires CI-only explicit opt-in, loopback, two distinct roles and same disposable test DB', () => {
  assert.ok(assertDisposablePerfConfig(safe));
  for (const patch of [
    { CI: undefined }, { GITHUB_ACTIONS: 'false' }, { SEDEAGRO_PERF_PROBE: 'yes' },
    { TEST_DATABASE_ADMIN_URL: 'postgres://owner:pass@prod.example.com:5432/sedeagro_test' },
    { TEST_DATABASE_APP_URL: 'postgres://app:pass@127.0.0.1:5432/sedeagro' },
    { TEST_DATABASE_APP_URL: 'postgres://app:pass@127.0.0.1:5432/other_test' },
    { TEST_DATABASE_APP_URL: 'postgres://sedeagro_owner:pass@127.0.0.1:5432/sedeagro_test' },
    { TEST_DATABASE_APP_URL: 'invalid-url' }
  ]) {
    assert.throws(() => assertDisposablePerfConfig({ ...safe, ...patch }), /BLOCKED/);
  }
});

test('nearest rank p50/p95 are computed from real values without interpolation or mutation', () => {
  const samples = [90, 10, 70, 20, 50, 40, 30];
  assert.equal(percentile(samples, .5), 40);
  assert.equal(percentile(samples, .95), 90);
  assert.deepEqual(samples, [90, 10, 70, 20, 50, 40, 30]);
  for (const input of [[Infinity], [-1], [], [NaN], ['2']]) {
    assert.throws(() => percentile(input, .95), /Invalid benchmark sample/);
  }
});

test('real state SQL remains before keyset limit and uses fixed group, not unsanitized user input', () => {
  const all = buildProbeSql(reviewer, 'all');
  const blocked = buildProbeSql(reviewer, 'blocked');
  assert.match(all, /EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
  assert.match(all, /ORDER BY.*LIMIT 51/);
  assert.doesNotMatch(all, /work_order_executions/);
  assert.match(blocked, /work_order_executions/);
  assert.match(blocked, /= ANY\(\$3::text\[\]\)/);
  assert.match(blocked, /"WorkOrder"\.tenant_id/);
  assert.ok(blocked.indexOf('work_order_executions') < blocked.indexOf('ORDER BY'));
  assert.throws(() => buildProbeSql(reviewer, 'unknown'), /Unrecognized/);
  assert.throws(() => buildProbeSql("'; DROP TABLE work_orders; --", 'blocked'), /Unrecognized/);
});

test('EXPLAIN aggregator consumes actual JSON plan and measures nested loops/buffers', () => {
  const parsed = summarizeExplain([{
    'Planning Time': 0.2, 'Execution Time': 7.345,
    Plan: { 'Node Type': 'Limit', 'Actual Rows': 51, 'Actual Loops': 1,
      'Shared Hit Blocks': 120, 'Shared Read Blocks': 2,
      Plans: [{ 'Node Type': 'Nested Loop', 'Actual Loops': 120,
        Plans: [{ 'Node Type': 'Seq Scan', 'Actual Loops': 120 }] }] }
  }]);
  assert.equal(parsed.executionMs, 7.345);
  assert.equal(parsed.returnedRows, 51);
  assert.equal(parsed.maxLoops, 120);
  assert.equal(parsed.sharedHitBlocks, 120);
  assert.deepEqual(parsed.planNodes, { Limit: 1, 'Nested Loop': 1, 'Seq Scan': 1 });
  assert.throws(() => summarizeExplain([{ Plan: {} }]), /complete analyzed/);
  assert.throws(() => summarizeExplain([{
    'Planning Time': 0, 'Execution Time': 0,
    Plan: { 'Node Type': 'Limit', 'Actual Rows': 0, 'Actual Loops': 1,
      Plans: [{ 'Actual Loops': 5 }] }
  }]), /malformed PostgreSQL plan node/);
});
