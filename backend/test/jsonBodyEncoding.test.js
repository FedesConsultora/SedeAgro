import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';

// Exercise the actual shared global parser before routing/auth, not an isolated
// helper that could pass while /api/v1 still accepts compressed request bodies.
async function startServer(t) {
  const server = createServer(createApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('all encoded JSON bodies are rejected before routing, and process stays alive', async (t) => {
  const origin = await startServer(t);
  const json = Buffer.from(JSON.stringify({ notes: 'private-observation-do-not-echo' }));
  const variants = [
    ['gzip', gzipSync(json)],
    ['deflate', deflateSync(json)],
    ['br', brotliCompressSync(json)]
  ];
  for (const [encoding, payload] of variants) {
    const response = await fetch(origin + '/api/v1/not-a-real-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': encoding },
      body: payload
    });
    assert.equal(response.status, 415, 'encoded JSON ' + encoding + ' must be rejected');
    const body = await response.text();
    assert.doesNotMatch(body, /private-observation-do-not-echo/);
    assert.doesNotMatch(body, /postgres:\/\/|JWT_SECRET|DATABASE_URL/);
    const alive = await fetch(origin + '/health');
    assert.equal(alive.status, 200, 'the HTTP process must remain alive');
    assert.equal((await alive.json()).ok, true);
  }
});

test('compressed JSON with trailing bytes is rejected before decompression', async (t) => {
  const origin = await startServer(t);
  const valid = gzipSync(Buffer.from('{"kind":"test"}'));
  const withTrailing = Buffer.concat([valid, Buffer.from([0, 255, 129, 23])]);
  const response = await fetch(origin + '/health', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: withTrailing
  });
  assert.equal(response.status, 415);
  const alive = await fetch(origin + '/health');
  assert.equal(alive.status, 200);
});

test('plain JSON stays supported and original body size limit stays unchanged', async (t) => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(source, /express\.json\(\{\s*limit:\s*'10mb',\s*inflate:\s*false\s*\}\)/);
  const origin = await startServer(t);
  const plain = await fetch(origin + '/health', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'test' })
  });
  assert.notEqual(plain.status, 415, 'a normal JSON body must not be rejected as encoded');
  const alive = await fetch(origin + '/health');
  assert.equal(alive.status, 200);
});
