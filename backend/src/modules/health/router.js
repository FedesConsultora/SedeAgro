import { Router } from 'express';
import { sequelize } from '../../core/db.js';
import { createReadinessProbe } from './readiness.js';

export function createHealthRouter({
  probe = createReadinessProbe({ check: () => sequelize.authenticate() }),
  revision = process.env.SEDEAGRO_BUILD_SHA
} = {}) {
  const router = Router();

  // Liveness: the HTTP process is alive. Not a release or database assertion.
  router.get('/', (_req, res) => {
    res.json({ ok: true, service: 'sedeagro-backend' });
  });

  // Readiness: the runtime database connection can currently authenticate.
  // Never leak connection strings, SQL errors, credentials or internal roles.
  router.get('/ready', async (_req, res) => {
    let ready = false;
    try {
      ready = (await probe()) === true;
    } catch {
      // A failing probe is always unavailable, never an unhandled 500 or 200.
    }
    res.set('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({ ready });
  });

  // This identifies the backend IMAGE revision, not the operator's local
  // checkout or a public client hint. Docker build validates full SHA40.
  // Missing/invalid build provenance must not be reported as a successful
  // staging release. Git commit SHAs are public; never include DSNs or tokens.
  router.get('/revision', (_req, res) => {
    const valid = typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision);
    res.set('Cache-Control', 'no-store');
    res.status(valid ? 200 : 503).json({ revision: valid ? revision : null });
  });

  return router;
}

export const healthRouter = createHealthRouter();
