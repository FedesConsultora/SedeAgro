import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertWorkerTenant, classifyReportFailure } from '../src/modules/reports/reportWorker.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const worker = source('../src/modules/reports/reportWorker.js');
const cli = source('../src/workers/reportWorkerCli.js');
const routes = source('../src/modules/reports/router.js');
const migration = source('../db/migrations/202610150002_report_run_artifacts.js');

test('worker refuses invalid or missing tenant; never discovers tenants with elevated SQL', () => {
  for (const value of [null, undefined, '', 'all', 'production', "'; DROP TABLE", 23]) {
    assert.throws(() => assertWorkerTenant(value), /single valid tenant UUID/);
  }
  assert.equal(assertWorkerTenant('0a000000-0000-4000-8000-000000000001'),
    '0a000000-0000-4000-8000-000000000001');
  assert.match(cli, /REPORT_WORKER_TENANT_ID/);
  assert.doesNotMatch(worker + cli, /\bSET ROLE\b|SELECT .* FROM tenants/);
});

test('SQL claims serialize by tenant, use SKIP LOCKED, TTL, CAS token and bounded retries', () => {
  assert.match(worker, /pg_try_advisory_xact_lock/);
  assert.match(worker, /SKIP LOCKED/);
  assert.match(worker, /attempt_count<3/);
  assert.match(worker, /lease_expires_at<=now\(\)/);
  assert.match(worker, /lease_token=:token AND lease_expires_at>now\(\)/);
  assert.match(worker, /status='completed'/);
  assert.match(worker, /INSERT INTO report_run_files/);
  assert.match(worker, /sha256/);
  assert.match(worker, /report_worker_presence/);
  assert.doesNotMatch(worker, /sequelize\.query\(/);
});

test('error classifications disclose only fixed codes, never private notes', () => {
  assert.equal(classifyReportFailure(new Error('El PDF supera máximo de páginas')), 'REPORT_TOO_LARGE');
  assert.equal(classifyReportFailure(new Error('caracteres no admitidos')), 'INVALID_REPORT');
  assert.equal(classifyReportFailure(new Error('lote no encontrado')), 'AUTHORITY_REVOKED');
  assert.equal(classifyReportFailure(new Error('password=secret')), 'PROCESSING_FAILED');
});

test('artifacts and worker presence use PostgreSQL FORCE RLS and expire', () => {
  assert.match(migration, /CREATE TABLE report_run_files/);
  assert.match(migration, /CREATE TABLE report_worker_presence/);
  assert.match(migration, /ALTER TABLE report_run_files FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE report_worker_presence FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REFERENCES report_runs\(tenant_id, id\)/);
  assert.match(migration, /octet_length\(content\) BETWEEN 1 AND 3145728/);
  assert.match(worker, /interval '7 days'/);
});

test('HTTP routes fail closed when no tenant worker heartbeats recently', () => {
  assert.match(routes, /REPORT_WORKER_OFFLINE/);
  assert.match(routes, /last_seen_at > now\(\)-interval '20 seconds'/);
  assert.match(routes, /requireCapability\('reports\.read'\)/);
  assert.match(routes, /requireCapability\('reports\.write'\)/);
  assert.match(routes, /Cache-Control', 'private, no-store'/);
  assert.match(routes, /RETRY_EXHAUSTED|REPORT_WORKER_OFFLINE/);
});
