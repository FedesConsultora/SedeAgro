// Cache only the public, immutable web application shell. Never cache API responses,
// private evidence, session data or any request with an Authorization header.
const CACHE = 'sedeagro-web-shell-v1';
const PREFIX = 'sedeagro-web-shell-';

async function cacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(new Request('/', { cache: 'reload', credentials: 'omit' }));
  if (!response.ok) return;
  await cache.put('/', response.clone());
  const html = await response.text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map((match) => match[1]))];
  await Promise.allSettled(assets.map((path) =>
    cache.add(new Request(path, { credentials: 'omit' }))));
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
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
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put('/', response.clone());
      }
      return response;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }

  // Vite emits content-hashed JS/CSS assets under /assets. The browser requests
  // them anonymously; only those public immutable files can be cached.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then(async (cached) => {
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
