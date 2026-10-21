// One tenant per least-privileged process. No discovery, BYPASSRLS or schema owner.
// An operator supplies REPORT_WORKER_TENANT_ID only after enrolling that tenant.
import { sequelize, connectDb } from '../core/db.js';
import '../models/index.js';
import { logger } from '../core/logger.js';
import { startReportWorkerHeartbeat } from './reportWorkerHeartbeat.js';
import { assertWorkerTenant, markReportWorkerPresent, processNextReport, purgeExpiredReportFiles } from '../modules/reports/reportWorker.js';

const tenantId = assertWorkerTenant(process.env.REPORT_WORKER_TENANT_ID);
const once = process.argv.includes('--once');
if (process.argv.slice(2).some(arg => arg !== '--once')) {
  throw new Error('Usage: reportWorkerCli.js [--once]');
}
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
await connectDb();
let heartbeat;
try {
  // A long render can exceed the API's 20s heartbeat freshness window.
  await markReportWorkerPresent(tenantId);
  heartbeat = startReportWorkerHeartbeat({
    write: () => markReportWorkerPresent(tenantId),
    onFailure: ({ code, consecutiveFailures }) => logger.warn('report_worker_heartbeat_issue', {
      code, consecutive_failures: consecutiveFailures
    })
  });
  let tick = 0;
  do {
    await markReportWorkerPresent(tenantId);
    const result = await processNextReport(tenantId);
    tick += 1;
    if (tick % 60 === 1) {
      const count = await purgeExpiredReportFiles(tenantId);
      if (count) logger.info('report_worker_expired_artifacts_removed', { count });
    }
    if (result.state !== 'idle') {
      logger.info('report_worker_job', {
        state: result.state, run_id: result.id, error_code: result.error_code || null
      });
    }
    if (!once && !stopping) {
      await new Promise(resolve => setTimeout(resolve, result.state === 'idle' ? 3000 : 300));
    }
  } while (!once && !stopping);
} finally {
  if (heartbeat) await heartbeat.stop();
  await sequelize.close();
}
