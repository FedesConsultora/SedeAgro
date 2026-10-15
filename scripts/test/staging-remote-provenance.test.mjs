import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  validateReleaseManifest, validateReleaseSource, verifyDeployedStaging
} from '../verify-deployed-staging.mjs';

const SHA = '1'.repeat(40);
const contents = {
  'index.html': '<!doctype html><html><script type="module" src="/assets/main-abcd1234.js"></script></html>',
  'sw.js': 'self.addEventListener("install", () => {});',
  'assets/main-abcd1234.js': 'console.log("release artifact");'
};
const hash = value => createHash('sha256').update(value).digest('hex');
function manifest() {
  return { schema: 'sedeagro-staging-build-v1', head: SHA,
    files: Object.entries(contents).map(([path, body]) =>
      ({ path, sha256: hash(body), size: Buffer.byteLength(body) })) };
}
async function withServer(handler, assertion) {
  const server = createServer((request, response) => {
    let path = request.url.split('?')[0];
    if (path === '/') path = '/index.html';
    const result = handler(path);
    response.statusCode = result.status ?? 200;
    response.setHeader('Cache-Control', path.startsWith('/assets/')
      ? 'public, max-age=31536000' : 'no-cache');
    if (result.location) response.setHeader('Location', result.location);
    response.end(result.body ?? '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await assertion(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
const original = path => {
  const body = contents[path.slice(1)];
  return body === undefined ? { status: 404, body: 'Not found' } : { body };
};
const verify = baseUrl => verifyDeployedStaging({
  baseUrl, expectedSha: SHA, manifest: manifest(), allowLoopback: true
});

test('rejects wrong source protocol and credential/query/path injection', () => {
  for (const value of ['http://staging.example.com', 'file:///tmp/file',
    'https://admin:pw@example.com', 'https://staging.example.com/test',
    'https://staging.example.com/?token=x', 'http://localhost:4040']) {
    assert.throws(() => validateReleaseSource(value), /HTTPS|origen|Staging URL/);
  }
  assert.throws(() => validateReleaseSource('http://127.0.0.1:3333'), /HTTPS/);
  assert.equal(validateReleaseSource('http://127.0.0.1:3333', true),
    'http://127.0.0.1:3333');
});

test('rejects SHA mismatch, traversal, duplicates and broken signatures before HTTP', () => {
  const good = manifest();
  assert.equal(validateReleaseManifest(good, SHA).length, 3);
  assert.throws(() => validateReleaseManifest(good, '2'.repeat(40)), /HEAD/);
  for (const badPath of ['../secret', '/absolute', 'assets//double.js',
    'assets/../../passwd', 'assets/%2e%2e/private', 'assets/a?bad',
    'assets/./same.js']) {
    const corrupted = manifest();
    corrupted.files[2].path = badPath;
    assert.throws(() => validateReleaseManifest(corrupted, SHA), /inseguro|incompleto/);
  }
  const duplicate = manifest();
  duplicate.files.push({ ...duplicate.files[2] });
  assert.throws(() => validateReleaseManifest(duplicate, SHA), /duplicado/);
  const tooLarge = manifest();
  tooLarge.files[2].size = 99_999_999;
  assert.throws(() => validateReleaseManifest(tooLarge, SHA), /inseguro/);
});

test('accepts only exact bytes of /, index, sw and the hashed asset', async () => {
  await withServer(original, async baseUrl => {
    const result = await verify(baseUrl);
    assert.deepEqual(result, {
      head: SHA, filesVerified: 3,
      bytesVerified: Object.values(contents).reduce((n, v) =>
        n + Buffer.byteLength(v), 0) + Buffer.byteLength(contents['index.html'])
    });
  });
});

test('blocks stale HTML at root even when /index.html is current', async () => {
  await withServer(path => path === '/index.html'
    ? { body: '<html>old release</html>' } : original(path),
  async baseUrl => assert.rejects(verify(baseUrl), /HASH\/TAMAÑO/));
});

test('blocks altered JS, missing files and poisoned service worker', async () => {
  for (const changed of ['/assets/main-abcd1234.js', '/sw.js']) {
    await withServer(path => path === changed ? { body: 'tampered' } : original(path),
      async baseUrl => assert.rejects(verify(baseUrl), /tamaño inesperado|HASH\/TAMAÑO/));
    await withServer(path => path === changed
      ? { status: 404, body: 'Not found' } : original(path),
    async baseUrl => assert.rejects(verify(baseUrl), /no respondió 200/));
  }
});

test('blocks redirects instead of following to an unrelated deployment', async () => {
  await withServer(path => path === '/assets/main-abcd1234.js'
    ? { status: 302, location: 'https://other.example.com/bundle.js' } : original(path),
  async baseUrl => assert.rejects(verify(baseUrl)));
});

test('blocks stale edge root independently of the trusted /index.html', async () => {
  const server = createServer((request, response) => {
    const route = request.url === '/' ? 'stale root' :
      contents[request.url.slice(1)];
    response.setHeader('cache-control', request.url.startsWith('/assets/')
      ? 'max-age=31536000' : 'no-cache');
    response.statusCode = route === undefined ? 404 : 200;
    response.end(route ?? '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(verify(`http://127.0.0.1:${server.address().port}`),
      /HASH\/TAMAÑO|tamaño inesperado/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('blocks unmanifested assets even with valid file hashes', async () => {
  const wrongManifest = manifest();
  wrongManifest.files[0] = {
    path: 'index.html',
    ...(() => {
      const body = '<script src="/assets/missing-referent.js"></script>';
      return { size: Buffer.byteLength(body), sha256: hash(body) };
    })()
  };
  await withServer(path => path === '/index.html'
    ? { body: '<script src="/assets/missing-referent.js"></script>' } : original(path),
  async baseUrl => assert.rejects(verifyDeployedStaging({
    baseUrl, expectedSha: SHA, manifest: wrongManifest, allowLoopback: true
  }), /no cubiertos/));
});

test('rejects unversioned JS cache directives as a release mismatch', async () => {
  const server = createServer((request, response) => {
    let key = request.url.slice(1);
    if (!key) key = 'index.html';
    response.setHeader('cache-control', 'no-cache');
    response.end(contents[key] || 'no');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(verify(`http://127.0.0.1:${server.address().port}`),
      /Asset sin política/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
