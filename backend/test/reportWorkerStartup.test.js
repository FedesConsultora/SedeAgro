import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReportWorkerEnvironment } from '../scripts/report-worker-startup.mjs';

const sha = 'a'.repeat(40);
const tenant = 'ab123456-1234-4234-8234-123456789abc';
const password = 'RuntimeCredential123456789abc';
const valid = {
  SEDEAGRO_BUILD_SHA: sha,
  REPORT_WORKER_TENANT_ID: tenant,
  SEDEAGRO_REPORT_WORKER_APPROVAL: `START_REPORT_WORKER:${sha}:${tenant}`,
  NODE_ENV: 'production',
  SEED_MODE: 'prod',
  LOG_SQL: '0',
  LOG_STACK: '0',
  JWT_SECRET: `sedeagro-worker-no-api-auth-${sha}`,
  POSTGRES_USER: 'sedeagro_owner',
  APP_DB_USER: 'sedeagro_app',
  POSTGRES_DB: 'sedeagro',
  DATABASE_URL: `postgres://sedeagro_app:${password}@db:5432/sedeagro`
};

const inspect = (overrides = {}) =>
  validateReportWorkerEnvironment({ ...valid, ...overrides });

test('one approved tenant is accepted without exposing credentials in output', () => {
  assert.deepEqual(inspect(), { release: sha, tenant, runtime: 'sedeagro_app' });
  assert.doesNotMatch(JSON.stringify(inspect()), /RuntimeCredential/);
});

test('approval is bound to exact built SHA and tenant', () => {
  for (const overrides of [
    { SEDEAGRO_BUILD_SHA: 'a'.repeat(39) },
    { REPORT_WORKER_TENANT_ID: 'other' },
    { REPORT_WORKER_TENANT_ID: tenant.toUpperCase() },
    { SEDEAGRO_REPORT_WORKER_APPROVAL: 'yes' },
    { SEDEAGRO_REPORT_WORKER_APPROVAL: `START_REPORT_WORKER:${sha}:${'b'.repeat(36)}` },
    { SEDEAGRO_REPORT_WORKER_APPROVAL: `START_REPORT_WORKER:${'b'.repeat(40)}:${tenant}` }
  ]) {
    assert.throws(() => inspect(overrides));
  }
});

test('worker refuses API signing keys and unsafe production flags', () => {
  for (const overrides of [
    { JWT_SECRET: 'API-SIGNING-SECRET-MUST-NEVER-BE-LOADED' },
    { JWT_SECRET: '' },
    { NODE_ENV: 'development' },
    { SEED_MODE: 'demo' },
    { LOG_SQL: '1' },
    { LOG_STACK: '1' }
  ]) assert.throws(() => inspect(overrides));
});

test('worker rejects owner, external connections and malformed runtime DB URLs', () => {
  for (const overrides of [
    { APP_DB_USER: 'sedeagro_owner' },
    { POSTGRES_USER: '' },
    { DATABASE_URL: 'postgres://sedeagro_owner:OwnerCredential123456789abc@db:5432/sedeagro' },
    { DATABASE_URL: `postgres://sedeagro_app:${password}@db.example.com:5432/sedeagro` },
    { DATABASE_URL: `postgres://sedeagro_app:${password}@localhost:5432/sedeagro` },
    { DATABASE_URL: `postgres://sedeagro_app:${password}@db:9999/sedeagro` },
    { DATABASE_URL: `postgres://sedeagro_app:${password}@db:5432/other` },
    { DATABASE_URL: `postgres://sedeagro_app:short@db:5432/sedeagro` },
    { DATABASE_URL: `postgres://sedeagro_app:${password}@db:5432/sedeagro?sslmode=disable` }
  ]) assert.throws(() => inspect(overrides));
});

test('invalid standalone start aborts before connecting and does not log secrets', () => {
  const entrypoint = fileURLToPath(new URL('../scripts/report-worker-startup.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entrypoint], {
    env: { ...process.env, ...valid, SEDEAGRO_REPORT_WORKER_APPROVAL: 'not-approved' },
    timeout: 3000, encoding: 'utf8'
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BLOCKED report worker startup/);
  assert.doesNotMatch(result.stderr + result.stdout, /RuntimeCredential|postgres:\/\//);
});
