import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

test('both production image builds install exactly their committed lockfile on Node22', () => {
  for (const service of ['backend', 'frontend']) {
    const dockerfile = read(service + '/Dockerfile');
    assert.match(dockerfile, /FROM node:22-alpine@sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(dockerfile, /FROM node:22-alpine(?:\s|$)/m);
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

test('backend production runtime does not carry npm global CVEs or depend on npm CLI', () => {
  const dockerfile = read('backend/Dockerfile');
  const deploy = read('scripts/deploy-prod.sh');
  const pkg = JSON.parse(read('backend/package.json'));
  assert.equal(pkg.scripts.start, 'node src/server.js');
  assert.equal(pkg.scripts.migrate, 'node src/infra/db/migrate.js up');
  assert.equal(pkg.scripts.seed, 'node src/infra/db/seed.js up');
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/);
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
  assert.doesNotMatch(dockerfile, /CMD \["npm", "start"\]/);
  assert.match(deploy, /node src\/infra\/db\/migrate\.js up && node src\/infra\/db\/seed\.js up/);
  assert.doesNotMatch(deploy, /npm run db:prepare/);
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
  const prod = dockerfile.split(/FROM nginx:1\.27-alpine@sha256:[a-f0-9]{64} AS prod/)[1];
  assert.ok(prod);
  assert.match(prod, /COPY --from=build \/app\/dist \/usr\/share\/nginx\/html/);
  assert.doesNotMatch(prod, /COPY \. \./);
});

test('production frontend Docker removes upstream Nginx sample files before copying manifest-bound dist', () => {
  const dockerfile = read('frontend/Dockerfile');
  const prod = dockerfile.split(/FROM nginx:1\.27-alpine@sha256:[a-f0-9]{64} AS prod/)[1];
  assert.ok(prod, 'expected final Nginx image stage');
  const clearing = prod.indexOf('RUN rm -rf /usr/share/nginx/html && mkdir -p /usr/share/nginx/html');
  const copying = prod.indexOf('COPY --from=build /app/dist /usr/share/nginx/html');
  assert.ok(clearing >= 0 && copying > clearing,
    'the exact public image document root must be wiped before the trusted Vite artifacts are copied');
  assert.doesNotMatch(prod, /COPY \. \./, 'never copy unreviewed build context into final image');
});

test('production containers embed exact approved SHA and expose OCI revision labels', () => {
  const backend = read('backend/Dockerfile');
  const frontend = read('frontend/Dockerfile');
  const compose = read('docker-compose.yml');
  for (const file of [backend, frontend]) {
    assert.match(file, /ARG RELEASE_SHA/);
    assert.match(file, /org\.opencontainers\.image\.revision/);
    assert.match(file, /\^\[0-9a-f\]\{40\}\$/);
  }
  assert.match(backend, /ENV SEDEAGRO_BUILD_SHA=\$\{RELEASE_SHA\}/);
  assert.equal((compose.match(/RELEASE_SHA: \$\{SEDEAGRO_RELEASE_SHA:\?/g) || []).length, 2);
});



test('opt-in report worker is not part of default Compose and stays tenant-internal', () => {
  const compose = read('docker-compose.yml');
  const optional = read('docker-compose.report-worker.yml');
  const prodDockerfile = read('backend/Dockerfile');
  assert.doesNotMatch(compose, /^  report-worker:/m,
    'default production compose must not autoactivate the reports worker');
  assert.match(optional, /^  report-worker:\n    profiles:\n      - reports/m);
  assert.match(optional, /command: \["node", "scripts\/report-worker-startup\.mjs"\]/);
  assert.match(prodDockerfile, /COPY scripts \.\/scripts/);
  assert.match(optional, /restart: unless-stopped/);
  assert.match(optional, /user: "node"/);
  assert.match(optional, /read_only: true/);
  assert.match(optional, /cap_drop:\n      - ALL/);
  assert.match(optional, /no-new-privileges:true/);
  assert.match(optional, /REPORT_WORKER_TENANT_ID: \$\{REPORT_WORKER_TENANT_ID:\?/);
  assert.match(optional, /SEDEAGRO_REPORT_WORKER_APPROVAL: \$\{SEDEAGRO_REPORT_WORKER_APPROVAL:\?/);
  assert.match(optional, /JWT_SECRET: sedeagro-worker-no-api-auth-\$\{SEDEAGRO_RELEASE_SHA:\?/);
  assert.match(optional, /APP_DB_PASSWORD:\?/);
  assert.match(optional, /networks:\n      - sedeagro_internal/);
  assert.doesNotMatch(optional, /^\s+(?:ports|env_file|privileged|network_mode):/m);
  assert.doesNotMatch(optional, /fedes-net/);
});
