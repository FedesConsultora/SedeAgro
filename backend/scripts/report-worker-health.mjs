// Container healthcheck. Uses the SAME tenant-bound runtime DB credential as
// the worker, never an admin role. No network listener, email or writes.
import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReportWorkerEnvironment } from './report-worker-startup.mjs';
import { inspectReportWorkerHealth } from '../src/workers/reportWorkerHealth.js';

export async function runReportWorkerHealth(env, createClient = options => new pg.Client(options)) {
  const { tenant, release } = validateReportWorkerEnvironment(env);
  const client = createClient({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 4000,
    query_timeout: 4000,
    statement_timeout: 3500,
    application_name: 'sedeagro-report-health'
  });
  try {
    await client.connect();
    return { release, ...await inspectReportWorkerHealth(client, tenant) };
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments supported');
    const result = await runReportWorkerHealth(process.env);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'critical' ? 2 : 0;
  } catch {
    // SQL error messages may include a URL, credentials or private content.
    console.error(JSON.stringify({ status: 'critical', reason_codes: ['HEALTH_PROBE_FAILED'] }));
    process.exitCode = 2;
  }
}
