import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { requestLogger } from './infra/http/requestLogger.js';
import { tenantResolver } from './infra/http/middlewares/tenantResolver.js';
import { tenantTransaction } from './infra/http/middlewares/tenantTransaction.js';
import { requireAuth } from './infra/http/middlewares/requireAuth.js';
import { healthRouter } from './modules/health/router.js';
import { authPublicRouter, authScopedRouter } from './modules/auth/router.js';
import { catalogsRouter } from './modules/catalogs/router.js';
import { farmsRouter } from './modules/farms/router.js';
import { fieldsRouter } from './modules/fields/router.js';
import { campaignsRouter } from './modules/campaigns/router.js';
import { scoutingRouter } from './modules/scouting/router.js';
import { workOrdersRouter } from './modules/workOrders/router.js';
import { teamsRouter } from './modules/teams/router.js';
import { assetsRouter } from './modules/assets/router.js';
import { imageryRouter } from './modules/imagery/router.js';
import { reportsRouter } from './modules/reports/router.js';
import { syncRouter } from './modules/sync/router.js';
import { notificationsRouter } from './modules/notifications/router.js';
import { platformRouter } from './modules/platform/router.js';
import { HttpError } from './utils/http.js';
import { logger } from './core/logger.js';

const defaultDevOrigins = ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'];

function allowedOrigins() {
  const configured = env.corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length ? configured : env.isProd ? [] : defaultDevOrigins;
}

function corsOptions() {
  const origins = allowedOrigins();
  return {
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) return callback(null, true);
      logger.warn('security.cors_denied', { origin });
      return callback(new HttpError(403, 'CORS: origen no permitido', undefined, 'CORS_DENIED'));
    },
    credentials: true
  };
}

function mountPublicRoutes(app, prefix = '/api') {
  app.use(`${prefix}/auth`, authPublicRouter);
}

function mountScopedRoutes(app, prefix = '/api') {
  app.use(`${prefix}/auth`, requireAuth, authScopedRouter);
  app.use(`${prefix}/catalogs`, requireAuth, catalogsRouter);
  app.use(`${prefix}/farms`, requireAuth, farmsRouter);
  app.use(`${prefix}/fields`, requireAuth, fieldsRouter);
  app.use(`${prefix}/campaigns`, requireAuth, campaignsRouter);
  app.use(`${prefix}/scouting`, requireAuth, scoutingRouter);
  app.use(`${prefix}/work-orders`, requireAuth, workOrdersRouter);
  app.use(`${prefix}/teams`, requireAuth, teamsRouter);
  app.use(`${prefix}/assets`, requireAuth, assetsRouter);
  app.use(`${prefix}/imagery`, requireAuth, imageryRouter);
  app.use(`${prefix}/reports`, requireAuth, reportsRouter);
  app.use(`${prefix}/sync`, requireAuth, syncRouter);
  app.use(`${prefix}/notifications`, requireAuth, notificationsRouter);
  app.use(`${prefix}/platform`, requireAuth, platformRouter);
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(requestLogger);
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: '10mb' }));

  app.use('/health', healthRouter);
  mountPublicRoutes(app, '/api');
  mountPublicRoutes(app, '/api/v1');

  app.use(tenantResolver);
  app.use(tenantTransaction);

  mountScopedRoutes(app, '/api');
  mountScopedRoutes(app, '/api/v1');

  app.use((_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada.')));

  app.use((error, req, res, _next) => {
    // Normalize Sequelize errors into HttpError-like shape
    if (error.name === 'SequelizeValidationError' || error.name === 'SequelizeUniqueConstraintError') {
      const fields = {};
      for (const e of error.errors || []) {
        const key = e.path || 'general';
        if (!fields[key]) fields[key] = [];
        fields[key].push(e.message);
      }
      error.status = error.name === 'SequelizeUniqueConstraintError' ? 409 : 422;
      error.code = error.name === 'SequelizeUniqueConstraintError' ? 'UNIQUE_CONSTRAINT' : 'VALIDATION_ERROR';
      error.details = { fieldErrors: fields };
      error.hint = error.name === 'SequelizeUniqueConstraintError'
        ? 'Ya existe un registro con estos datos. Revisá los campos duplicados.'
        : 'Revisá los campos marcados y corregí los errores.';
      error.expose = true;
      error.message = error.name === 'SequelizeUniqueConstraintError'
        ? 'Registro duplicado'
        : 'Error de validación';
    }

    const status = error.status || 500;
    const isPublicError = status < 500 && error.expose !== false;

    if (status >= 500) {
      logger.error('http.unhandled_error', {
        request_id: req.requestId,
        error
      });
    } else {
      logger.warn('http.handled_error', {
        request_id: req.requestId,
        status,
        code: error.code,
        message: error.message
      });
    }

    res.status(status).json({
      error: {
        code: error.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
        message: isPublicError ? error.message : 'Error interno del servidor.',
        hint: isPublicError ? (error.hint || null) : 'Intentá de nuevo en unos minutos. Si el problema persiste, contactá al soporte.',
        details: isPublicError ? error.details : undefined,
        request_id: req.requestId
      }
    });
  });

  return app;
}
