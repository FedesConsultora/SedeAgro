import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

test('both production image builds install exactly their committed lockfile on Node22', () => {
  for (const service of ['backend', 'frontend']) {
    const dockerfile = read(service + '/Dockerfile');
    assert.match(dockerfile, /FROM node:22-alpine/);
    assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
    assert.match(dockerfile, /RUN npm ci(?: --omit=dev)?/);
    assert.doesNotMatch(dockerfile, /\bRUN npm install\b/);
    assert.doesNotMatch(dockerfile, /\bFROM node:20/);
    const pkg = JSON.parse(read(service + '/package.json'));
    const lock = JSON.parse(read(service + '/package-lock.json'));
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.packages[''].name, pkg.name);
    assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
    assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  }
});

test('production backend copies only explicit application directories', () => {
  const dockerfile = read('backend/Dockerfile');
  const prod = dockerfile.split('FROM base AS prod')[1];
  assert.ok(prod, 'production target is required');
  assert.doesNotMatch(prod, /COPY \. \./);
  for (const target of ['src', 'db', 'scripts']) {
    assert.ok(prod.includes('COPY ' + target + ' ./' + target));
  }
  assert.match(prod, /RUN npm ci --omit=dev/);
});

test('Docker contexts exclude local environment, secret material and installed dependencies', () => {
  for (const service of ['backend', 'frontend']) {
    const ignore = read(service + '/.dockerignore').split(/\r?\n/);
    for (const required of ['.env', '.env.*', 'node_modules', '*.pem', '*.key']) {
      assert.ok(ignore.includes(required), service + ' missing ' + required);
    }
    assert.ok(ignore.includes('*.log') || ignore.includes('npm-debug.log*'));
  }
});

test('frontend build requires same-origin API and serves only compiled assets', () => {
  const dockerfile = read('frontend/Dockerfile');
  assert.match(dockerfile, /ARG VITE_API_URL=\/api/);
  assert.match(dockerfile, /RUN npm run build/);
  const prod = dockerfile.split('FROM nginx:1.27-alpine AS prod')[1];
  assert.ok(prod);
  assert.match(prod, /COPY --from=build \/app\/dist \/usr\/share\/nginx\/html/);
  assert.doesNotMatch(prod, /COPY \. \./);
});
