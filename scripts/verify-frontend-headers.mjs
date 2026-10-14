import assert from 'node:assert/strict';

const baseUrl = process.argv[2];
if (!baseUrl || !/^http:\/\/127[.]0[.]0[.]1:\d+\/?$/.test(baseUrl)) {
  throw new Error('Usage: node scripts/verify-frontend-headers.mjs http://127.0.0.1:4182');
}
const root = baseUrl.replace(/\/$/, '');
async function get(path) {
  let response;
  for (let i = 0; i < 30; i++) {
    try {
      response = await fetch(root + path);
      break;
    } catch (error) {
      if (i === 29) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  assert.equal(response.status, 200, `Unexpected status for ${path}`);
  return response;
}

const html = await get('/');
const policy = html.headers.get('content-security-policy') || '';
const required = [
  "default-src 'self'", "script-src 'self'", "connect-src 'self'",
  "worker-src 'self'", "object-src 'none'", "frame-ancestors 'none'",
  "base-uri 'self'", "form-action 'self'"
];
for (const rule of required) assert.ok(policy.includes(rule), 'Missing CSP: ' + rule);
const scripts = policy.match(/script-src[^;]*/)?.[0] || '';
assert.ok(!scripts.includes('unsafe-inline'), 'Executable inline scripts must be blocked');
assert.ok(!scripts.includes('unsafe-eval'), 'Eval must remain blocked');
assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
assert.equal(html.headers.get('x-frame-options'), 'DENY');
assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
assert.ok((html.headers.get('permissions-policy') || '').includes('geolocation=()'));
assert.match(html.headers.get('cache-control') || '', /no-cache/i);

const markup = await html.text();
assert.doesNotMatch(markup, /fonts[.]googleapis[.]com|fonts[.]gstatic[.]com/);
const assets = [...markup.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(x => x[1]);
assert.ok(assets.length > 0, 'No versioned assets in built HTML');
for (const asset of assets) {
  const response = await get(asset);
  assert.equal(response.headers.get('content-security-policy'), policy);
  assert.match(response.headers.get('cache-control') || '', /max-age=\d{7,}/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

const serviceWorker = await get('/sw.js');
assert.equal(serviceWorker.headers.get('content-security-policy'), policy);
assert.match(serviceWorker.headers.get('cache-control') || '', /no-cache/i);
assert.ok((await serviceWorker.text()).includes('self.addEventListener'));

const fallback = await get('/scouting');
assert.equal(fallback.headers.get('content-security-policy'), policy);
assert.match(fallback.headers.get('cache-control') || '', /no-cache/i);
console.log('PASS: Nginx live headers, CSP, SPA routing, immutable assets and no-cache shell/SW');
