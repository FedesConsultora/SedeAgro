import { randomUUID } from 'node:crypto';
import { getTenantContext } from '../../core/tenantContext.js';
import { logger } from '../../core/logger.js';

export function requestLogger(req, res, next) {
  req.requestId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const ctx = getTenantContext();
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http.request', {
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
      tenant_id: ctx.tenantId || null,
      user_id: ctx.userId || null,
      ip: req.ip,
      user_agent: req.headers['user-agent']
    });
  });

  next();
}
