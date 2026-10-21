// Opt-in, tenant-bound report worker admission. Never logs database credentials.
// This is NOT an HTTP application and must never receive the API JWT signing key.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function validateReportWorkerEnvironment(env) {
  const release = env.SEDEAGRO_BUILD_SHA;
  const tenant = env.REPORT_WORKER_TENANT_ID;
  if (!SHA.test(release || '')) throw new Error('missing exact built release SHA');
  if (!UUID.test(tenant || '')) throw new Error('expected one canonical tenant UUID');
  if (env.SEDEAGRO_REPORT_WORKER_APPROVAL !== `START_REPORT_WORKER:${release}:${tenant}`) {
    throw new Error('worker requires explicit approval for built SHA and tenant');
  }
  if (env.NODE_ENV !== 'production' || env.SEED_MODE !== 'prod' ||
      env.LOG_SQL !== '0' || env.LOG_STACK !== '0') {
    throw new Error('worker must run with production settings and SQL/stack logs disabled');
  }

  // env.js currently requires JWT_SECRET for all production entrypoints.
  // Supply ONLY an isolated non-API marker, NEVER the real API signing secret.
  if (env.JWT_SECRET !== `sedeagro-worker-no-api-auth-${release}`) {
    throw new Error('worker must not receive the API JWT signing secret');
  }
  const owner = env.POSTGRES_USER;
  const runtime = env.APP_DB_USER;
  const dbName = env.POSTGRES_DB;
  if (!/^[a-z_][a-z0-9_]*$/.test(owner || '') ||
      !/^[a-z_][a-z0-9_]*$/.test(runtime || '') || runtime === owner ||
      !/^[a-z_][a-z0-9_]*$/.test(dbName || '')) {
    throw new Error('worker requires an explicit, distinct runtime database role');
  }

  let url;
  try { url = new URL(env.DATABASE_URL); } catch {
    throw new Error('worker DATABASE_URL invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'db' ||
      (url.port && url.port !== '5432') || url.username !== runtime ||
      !url.password || url.password.length < 24 ||
      url.pathname !== `/${dbName}` || url.search || url.hash) {
    throw new Error('worker DATABASE_URL must target internal PostgreSQL using runtime role');
  }
  return { release, tenant, runtime };
}

// When imported by tests, no environment reads, DB connection or worker loop occur.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    validateReportWorkerEnvironment(process.env);
    await import('../src/workers/reportWorkerCli.js');
  } catch {
    // Database errors may contain credentials: never print their messages.
    console.error('BLOCKED report worker startup or runtime; inspect sanitized operational telemetry.');
    process.exitCode = 2;
  }
}
