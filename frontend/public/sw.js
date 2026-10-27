// Cache only the public, immutable web application shell. Never cache API responses,
// private evidence, session data or any request with an Authorization header.
// Bump this version whenever the shell's install/activation contract changes.
const CACHE = 'sedeagro-web-shell-v3';
const PREFIX = 'sedeagro-web-shell-';

function shellAssets(html) {
  return [...new Set([...html.matchAll(/(?:src|href)=["'](\\/assets\\/[^"']+)["']/g)]
    .map((match) => match[1]))];
}

async function cacheShell() {
  // A successful HTML response is not sufficient: it may reference a NEW
  // deployment's JS/CSS while the worker still owns an OLD offline shell.
  const response = await fetch(new Request('/', { cache: 'reload', credentials: 'omit' }));
  if (!response.ok) throw new Error('Cannot install offline shell without a successful HTML response.');
  const html = await response.clone().text();
  const assets = shellAssets(html);
  if (assets.length === 0) throw new Error('Cannot install offline shell without bundled assets.');

  const cache = await caches.open(CACHE);
  // Cache ALL referenced assets first. A failed fetch aborts installation,
  // leaves the prior active worker intact, and never publishes a broken root.
  await Promise.all(assets.map((path) =>
    cache.add(new Request(path, { credentials: 'omit' }))));
  await cache.put('/', response);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const shell = await cache.match('/');
    if (!shell) throw new Error('Offline shell was not completely installed.');
    const assets = shellAssets(await shell.text());
    if (!assets.length || !(await Promise.all(assets.map((path) => cache.match(path)))).every(Boolean)) {
      throw new Error('Offline shell is missing a required asset.');
    }
    // Never discard the previous working version before the replacement has
    // passed the full shell + bundled asset check.
    const keys = await caches.keys();
    await Promise.all(keys.filter((name) => name.startsWith(PREFIX) && name !== CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Network-first for the CURRENT tab. Never overwrite the installed shell
    // with a newer HTML document until its entire asset set was cached by a
    // successfully installed new service worker. Otherwise an online visit
    // during deployment can poison the offline cold-start cache.
    // Only cache the public SPA entrypoint, never arbitrary server-rendered pages.
    if (url.pathname !== '/') return;
    event.respondWith(fetch(request).catch(async () =>
      (await (await caches.open(CACHE)).match('/')) || Response.error()));
    return;
  }

  // Vite emits content-hashed JS/CSS assets under /assets. The browser requests
  // them anonymously; only those public immutable files can be cached.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(url.pathname, { ignoreVary: true }).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    }));
  }
});
