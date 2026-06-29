import { Tenant } from '../../../models/index.js';
import { env } from '../../../config/env.js';
import { runWithTenantContext } from '../../../core/tenantContext.js';
import { HttpError } from '../../../utils/http.js';

const globalPaths = [
  '/health',
  '/api/auth/login',
  '/api/auth/register-tenant',
  '/api/auth/invite/accept',
  '/api/auth/password/reset-request',
  '/api/auth/password/reset-confirm',
  '/api/v1/auth/login',
  '/api/v1/auth/register-tenant',
  '/api/v1/auth/invite/accept',
  '/api/v1/auth/password/reset-request',
  '/api/v1/auth/password/reset-confirm'
];

function isGlobalPath(path) {
  return globalPaths.some((globalPath) => path === globalPath)
    || path.startsWith('/api/webhooks/')
    || path.startsWith('/api/v1/webhooks/');
}

function slugFromHost(host = '') {
  const cleanHost = host.split(':')[0];
  if (!cleanHost || cleanHost === 'localhost' || cleanHost === '127.0.0.1') return null;
  if (env.baseDomain && cleanHost.endsWith(env.baseDomain)) {
    const slug = cleanHost.replace(`.${env.baseDomain}`, '');
    return slug && slug !== env.baseDomain ? slug : null;
  }
  const parts = cleanHost.split('.');
  return parts.length > 2 ? parts[0] : null;
}

export async function tenantResolver(req, _res, next) {
  try {
    if (isGlobalPath(req.path)) return next();

    const headerTenantId = req.headers['x-tenant-id'];
    const headerTenantSlug = req.headers['x-tenant-slug'];
    const hostSlug = slugFromHost(req.headers.host);
    const fallbackTenantId = !env.isProd ? env.fallbackTenantId : '';

    const where = hostSlug || headerTenantSlug
      ? { slug: hostSlug || headerTenantSlug }
      : { id: headerTenantId || fallbackTenantId };

    if (!where.id && !where.slug) {
      throw new HttpError(400, 'No se pudo resolver el tenant. En dev enviá x-tenant-id o x-tenant-slug.');
    }

    const tenant = await Tenant.findOne({
      where,
      attributes: ['id', 'slug', 'name', 'status', 'plan_id'],
      skipTenantScope: true
    });

    if (!tenant) throw new HttpError(404, 'Tenant no encontrado.');
    if (!['onboarding', 'active'].includes(tenant.status)) {
      throw new HttpError(403, 'Tenant suspendido o eliminado.');
    }

    req.tenant = tenant;
    req.tenantId = tenant.id;

    return runWithTenantContext({ tenantId: tenant.id, tenantSlug: tenant.slug }, () => next());
  } catch (error) {
    next(error);
  }
}
