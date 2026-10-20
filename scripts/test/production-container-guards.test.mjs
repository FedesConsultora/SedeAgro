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

test('frontend lock contains every optional Rolldown native target with verified integrity', () => {
  const lock = JSON.parse(read('frontend/package-lock.json'));
  const root = JSON.parse(read('package-lock.json'));
  const deps = lock.packages['node_modules/rolldown']?.optionalDependencies;
  assert.ok(deps && Object.keys(deps).length >= 10);
  for (const [name, version] of Object.entries(deps)) {
    const key = 'node_modules/' + name;
    const item = lock.packages[key];
    const trusted = root.packages[key];
    assert.ok(item, 'missing native optional dependency: ' + key);
    assert.equal(item.version, version);
    assert.equal(item.integrity, trusted?.integrity, key + ' differs from root lock integrity');
    assert.ok(/^sha512-/.test(item.integrity), key + ' lacks integrity');
  }
  assert.ok(lock.packages['node_modules/@rolldown/binding-linux-x64-musl']);
  assert.ok(lock.packages['node_modules/@rolldown/binding-linux-x64-gnu']);
});

test('platform-specific LightningCSS and Parcel native bindings stay locked', () => {
  const lock = JSON.parse(read('frontend/package-lock.json'));
  const root = JSON.parse(read('package-lock.json'));
  for (const [base, prefix] of [
    ['node_modules/lightningcss', 'node_modules/'],
    ['node_modules/@parcel/watcher', 'node_modules/']
  ]) {
    const optional = lock.packages[base]?.optionalDependencies || {};
    assert.ok(Object.keys(optional).length > 6);
    for (const [name, version] of Object.entries(optional)) {
      const key = prefix + name;
      const entry = lock.packages[key];
      assert.ok(entry, 'missing optional native binding: ' + key);
      assert.equal(entry.version, version);
      assert.equal(entry.integrity, root.packages[key]?.integrity);
      assert.match(entry.integrity, /^sha512-/);
    }
  }
  assert.ok(lock.packages['node_modules/lightningcss-linux-x64-musl']?.integrity);
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
