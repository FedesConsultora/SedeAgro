import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createReadinessProbe } from '../src/modules/health/readiness.js';
import { createHealthRouter } from '../src/modules/health/router.js';

test('readiness probe is strict about its dependencies and timeouts', () => {
  assert.throws(() => createReadinessProbe(), /Invalid readiness/);
  assert.throws(() => createReadinessProbe({ check: () => true, timeoutMs: 0 }), /Invalid readiness/);
  assert.throws(() => createReadinessProbe({ check: () => true, ttlMs: 10001 }), /Invalid readiness/);
});

test('coalesces burst traffic and caches a true result for the configured short TTL', async () => {
  let calls = 0;
  let tick = 100;
  const probe = createReadinessProbe({
    now: () => tick, ttlMs: 25, timeoutMs: 200,
    check: async () => { calls += 1; await new Promise(r => setTimeout(r, 10)); }
  });
  const burst = await Promise.all(Array.from({ length: 12 }, () => probe()));
  assert.deepEqual(burst, Array(12).fill(true));
  assert.equal(calls, 1);
  assert.equal(await probe(), true);
  assert.equal(calls, 1);
  tick += 26;
  assert.equal(await probe(), true);
  assert.equal(calls, 2);
});

test('reports failure and recovers only after a fresh check, never stale success', async () => {
  let tick = 100;
  let works = true;
  let calls = 0;
  const probe = createReadinessProbe({
    now: () => tick, ttlMs: 5, timeoutMs: 200,
    check: async () => {
      calls += 1;
      if (!works) throw new Error('password=secret; connection refused');
    }
  });
  assert.equal(await probe(), true);
  works = false;
  assert.equal(await probe(), true, 'short-lived cache is intentional');
  tick += 6;
  assert.equal(await probe(), false);
  assert.equal(await probe(), false);
  assert.equal(calls, 2);
  works = true;
  tick += 6;
  assert.equal(await probe(), true);
  assert.equal(calls, 3);
});

test('times out fast and never piles up database checks while an earlier call hangs', async () => {
  let calls = 0;
  let finish;
  let tick = 0;
  const probe = createReadinessProbe({
    now: () => tick, ttlMs: 2, timeoutMs: 10,
    check: () => {
      calls += 1;
      return new Promise(resolve => { finish = resolve; });
    }
  });
  assert.equal(await probe(), false);
  tick += 3;
  assert.equal(await probe(), false);
  assert.equal(calls, 1, 'a timed-out query remains the single upstream in-flight check');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  tick += 3;
  assert.equal(await probe(), false, 'the new unresolved database check also times out');
  assert.equal(calls, 2);
});

test('revision endpoint serves only a full image SHA and never claims missing provenance', async (t) => {
  const sha = 'b'.repeat(40);
  const app = express();
  app.use('/valid', createHealthRouter({ probe: async () => true, revision: sha }));
  app.use('/missing', createHealthRouter({ probe: async () => true, revision: null }));
  app.use('/invalid', createHealthRouter({ probe: async () => true, revision: 'demo' }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const success = await fetch(base + '/valid/revision');
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await success.json(), { revision: sha });
  for (const endpoint of ['/missing/revision', '/invalid/revision']) {
    const result = await fetch(base + endpoint);
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), { revision: null });
  }
});

test('HTTP liveness remains 200 and readiness provides 503/200, no-store, no details', async (t) => {
  let healthy = false;
  let reject = false;
  const app = express();
  app.use('/health', createHealthRouter({
    probe: async () => {
      if (reject) throw new Error('postgres://user:private_password@db/');
      return healthy;
    }
  }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const live = await fetch(url + '/health');
  assert.equal(live.status, 200);
  assert.equal((await live.json()).ok, true);
  const unavailable = await fetch(url + '/health/ready');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unavailable.json(), { ready: false });
  healthy = true;
  const available = await fetch(url + '/health/ready');
  assert.equal(available.status, 200);
  assert.equal(available.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await available.json(), { ready: true });
  reject = true;
  const failure = await fetch(url + '/health/ready');
  assert.equal(failure.status, 503);
  const body = await failure.text();
  assert.doesNotMatch(body, /private_password|postgres:\/\//);
  assert.deepEqual(JSON.parse(body), { ready: false });
});
