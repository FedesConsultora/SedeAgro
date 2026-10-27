import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://field.example.test';
const cacheName = 'sedeagro-web-shell-v3';
const oldCacheName = 'sedeagro-web-shell-v2';
const oldHtml = '<script type="module" src="/assets/old-1.js"></script><link href="/assets/old-2.css" rel="stylesheet">';
const newHtml = '<script type="module" src="/assets/new-1.js"></script><link href="/assets/new-2.css" rel="stylesheet">';

function createWorker({ html = oldHtml, failing = [], legacy = false } = {}) {
  const listeners = new Map();
  const stores = new Map();
  const calls = [];
  const blocked = new Set(failing);
  let online = true;
  let landing = html;
  let skipped = 0;
  let claimed = 0;
  const keyOf = (request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const responseFor = (path) => {
    if (!online) return Promise.reject(new Error('airplane mode'));
    const url = new URL(path, origin);
    calls.push(url.pathname);
    if (blocked.has(url.pathname)) return Promise.resolve(new Response('missing', { status: 404 }));
    if (url.pathname === '/') return Promise.resolve(new Response(landing, {
      status: 200, headers: { 'content-type': 'text/html' }
    }));
    return Promise.resolve(new Response('asset:' + url.pathname, { status: 200 }));
  };
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const rows = stores.get(name);
    return {
      async put(request, response) { rows.set(keyOf(request), response.clone()); },
      async match(request) { return rows.get(keyOf(request))?.clone(); },
      async add(request) {
        const response = await responseFor(keyOf(request));
        if (!response.ok) throw new Error('Cache.add requires a successful response.');
        rows.set(keyOf(request), response.clone());
      },
      async keys() { return [...rows.keys()].map((url) => new Request(url)); }
    };
  };
  const caches = {
    open: async (name) => store(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (request) => {
      for (const rows of stores.values()) {
        if (rows.has(keyOf(request))) return rows.get(keyOf(request)).clone();
      }
      return undefined;
    }
  };
  if (legacy) {
    const rows = new Map();
    rows.set(keyOf('/'), new Response(oldHtml));
    rows.set(keyOf('/assets/old-1.js'), new Response('old-js'));
    rows.set(keyOf('/assets/old-2.css'), new Response('old-css'));
    stores.set(oldCacheName, rows);
  }
  const self = {
    location: { origin },
    addEventListener: (name, handler) => listeners.set(name, handler),
    skipWaiting: async () => { skipped += 1; },
    clients: { claim: async () => { claimed += 1; } }
  };
  class BrowserRequest extends Request {
    constructor(input, init) { super(new URL(input, origin), init); }
  }
  vm.runInNewContext(source, { self, caches, fetch: async (request) => responseFor(keyOf(request)),
    Request: BrowserRequest, Response, URL, Set, Error });
  return {
    caches, calls, stores,
    setOnline: (value) => { online = value; },
    setHtml: (value) => { landing = value; },
    get skipped() { return skipped; },
    get claimed() { return claimed; },
    async event(name, request) {
      let pending;
      const e = {
        request,
        waitUntil(value) { pending = value; },
        respondWith(value) { pending = value; }
      };
      listeners.get(name)(e);
      return pending;
    },
    request(path, mode = 'cors', headers = {}) {
      // Node Request does not implement mode=navigate; shim only the property
      // that service workers receive from real browser Request instances.
      const request = new BrowserRequest(path, { headers });
      Object.defineProperty(request, 'mode', { value: mode });
      return request;
    }
  };
}

test('install verifies both bundled assets before publishing an offline shell', async () => {
  const worker = createWorker({ legacy: true });
  await worker.event('install');
  assert.equal(worker.skipped, 1);
  const cache = await worker.caches.open(cacheName);
  assert.equal(await (await cache.match('/')).text(), oldHtml);
  assert.ok(await cache.match('/assets/old-1.js'));
  assert.ok(await cache.match('/assets/old-2.css'));
  await worker.event('activate');
  assert.equal(worker.claimed, 1);
  assert.deepEqual(await worker.caches.keys(), [cacheName]);
});

test('online release does not poison an installed offline shell with an uncached asset manifest', async () => {
  const worker = createWorker();
  await worker.event('install');
  await worker.event('activate');
  worker.setHtml(newHtml);
  const online = await worker.event('fetch', worker.request('/', 'navigate'));
  assert.equal(await online.text(), newHtml, 'online tab sees current deployment');
  const cache = await worker.caches.open(cacheName);
  assert.equal(await (await cache.match('/')).text(), oldHtml, 'offline snapshot remains atomic');
  worker.setOnline(false);
  const offline = await worker.event('fetch', worker.request('/', 'navigate'));
  assert.equal(await offline.text(), oldHtml);
  assert.equal(await (await worker.event('fetch', worker.request('/assets/old-1.js'))).text(),
    'asset:/assets/old-1.js');
  assert.ok(worker.calls.includes('/'));
});

test('HTTP error, missing asset or HTML without a bundle cannot replace a working service worker', async () => {
  for (const scenario of [
    { failing: ['/'] },
    { failing: ['/assets/old-2.css'] },
    { html: '<html>temporary error page</html>' }
  ]) {
    const worker = createWorker({ ...scenario, legacy: true });
    await assert.rejects(worker.event('install'));
    assert.equal(worker.skipped, 0);
    assert.equal(await (await (await worker.caches.open(oldCacheName)).match('/')).text(), oldHtml);
    assert.equal(await (await worker.caches.open(cacheName)).match('/'), undefined);
  }
});

test('activation refuses to destroy the previous shell if the replacement is incomplete', async () => {
  const worker = createWorker({ legacy: true });
  await worker.event('install');
  worker.stores.get(cacheName).delete(new URL('/assets/old-2.css', origin).href);
  await assert.rejects(worker.event('activate'), /missing a required asset/);
  assert.ok((await worker.caches.keys()).includes(oldCacheName));
  assert.equal(worker.claimed, 0);
});

test('never intercepts or caches API, Authorization, other origin or POST requests', async () => {
  const worker = createWorker();
  await worker.event('install');
  await worker.event('activate');
  for (const request of [
    worker.request('/api/v1/auth/me'),
    worker.request('/', 'navigate', { authorization: 'Bearer private' }),
    worker.request('https://other.example.test/'),
    new Request(origin + '/api/v1/scouting', { method: 'POST' })
  ]) assert.equal(await worker.event('fetch', request), undefined);
  const cache = await worker.caches.open(cacheName);
  assert.equal(await cache.match('/api/v1/auth/me'), undefined);
});
