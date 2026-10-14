import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deferResponseUntilTransactionSettles } from '../src/infra/http/middlewares/transactionalResponse.js';

const logs = { error() {} };

async function startServer(t, transaction, handler) {
  const server = http.createServer((req, res) => {
    deferResponseUntilTransactionSettles(req, res, (error) => {
      assert.ok(error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }));
    }, transaction, logs);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('success reaches client only after commit succeeds', async (t) => {
  let release;
  let started;
  const committing = new Promise((resolve) => { started = resolve; });
  const commitGate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const transaction = {
    async commit() { events.push('commit-start'); started(); await commitGate; events.push('commit-done'); },
    async rollback() { events.push('rollback'); }
  };
  const url = await startServer(t, transaction, (_req, res) => {
    res.statusCode = 201;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"saved":true}');
  });
  const request = fetch(url).then(async (response) => ({
    status: response.status, body: await response.json()
  }));
  await committing;
  try {
    const beforeCommit = await Promise.race([
      request.then(() => 'response-sent'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 40))
    ]);
    assert.equal(beforeCommit, 'waiting', 'client must wait for commit');
  } finally {
    release();
  }
  assert.deepEqual(await request, { status: 201, body: { saved: true } });
  assert.deepEqual(events, ['commit-start', 'commit-done']);
});

test('4xx response is transmitted only after rollback completes', async (t) => {
  const events = [];
  const transaction = {
    async commit() { events.push('unexpected-commit'); },
    async rollback() { events.push('rollback'); }
  };
  const url = await startServer(t, transaction, (_req, res) => {
    res.statusCode = 403;
    res.end('denied');
  });
  const response = await fetch(url);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), 'denied');
  assert.deepEqual(events, ['rollback']);
});

test('commit error never sends the stale successful body or status', async (t) => {
  let rollback = 0;
  const transaction = {
    async commit() { throw new Error('commit unavailable'); },
    async rollback() { rollback += 1; }
  };
  const url = await startServer(t, transaction, (_req, res) => {
    res.statusCode = 201;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Length', '21');
    res.setHeader('ETag', 'stale');
    res.end('sensitive result body');
  });
  const response = await fetch(url);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR' } });
  assert.equal(rollback, 1);
  assert.equal(response.headers.get('etag'), null);
});

test('failed rollback cannot falsely report the original client error', async (t) => {
  const transaction = {
    async commit() { throw new Error('unexpected'); },
    async rollback() { throw new Error('rollback unavailable'); }
  };
  const url = await startServer(t, transaction, (_req, res) => {
    res.statusCode = 422;
    res.end('validation error');
  });
  const response = await fetch(url);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR' } });
});

test('streaming write is rejected and rolled back before any data leaks', async (t) => {
  let committed = 0;
  let rolledBack = 0;
  const transaction = {
    async commit() { committed++; },
    async rollback() { rolledBack++; }
  };
  const url = await startServer(t, transaction, (_req, res) => {
    res.write('unsafe-before-commit');
    res.end('this-must-not-be-sent');
  });
  const response = await fetch(url);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR' } });
  assert.equal(committed, 0);
  assert.equal(rolledBack, 1);
});

test('client disconnect without response triggers rollback', async (t) => {
  let entered;
  let rollbackDone;
  const ready = new Promise((resolve) => { entered = resolve; });
  const rolledBack = new Promise((resolve) => { rollbackDone = resolve; });
  const transaction = {
    async commit() { throw new Error('must not commit'); },
    async rollback() { rollbackDone(); }
  };
  const url = await startServer(t, transaction, () => entered());
  const request = http.get(url);
  request.on('error', () => {}); // An intentional aborted request.
  await ready;
  request.destroy();
  await rolledBack;
});
