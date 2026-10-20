import { Router } from 'express';
import { sequelize } from '../../core/db.js';
import { createReadinessProbe } from './readiness.js';

export function createHealthRouter({
  probe = createReadinessProbe({ check: () => sequelize.authenticate() })
} = {}) {
  const router = Router();

  // Liveness: the HTTP process is alive. Not a release or database assertion.
  router.get('/', (_req, res) => {
    res.json({ ok: true, service: 'sedeagro-backend' });
  });

  // Readiness: the runtime database connection can currently authenticate.
  // Never leak connection strings, SQL errors, credentials or internal roles.
  router.get('/ready', async (_req, res) => {
    const ready = await probe();
    res.set('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({ ready });
  });

  return router;
}

export const healthRouter = createHealthRouter();
