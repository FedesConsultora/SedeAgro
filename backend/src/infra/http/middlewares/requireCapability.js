import { HttpError } from '../../../utils/http.js';

// Server-side tenant RBAC. Entitlements only select paid modules; they do not authorize actions.
// producer_viewer can read GIS only through explicit producer_access_grants;
// the farms/fields routers must filter every returned resource by those grants.
const CAPABILITIES = Object.freeze({
  tenant_admin: ['*'],
  agronomic_coordinator: [
    'members.read', 'gis.read', 'gis.write', 'water.write',
    'campaigns.read', 'campaigns.write',
    'scouting.read', 'scouting.plan', 'scouting.observe', 'scouting.evidence',
    'orders.read', 'orders.write', 'orders.execute',
    'teams.read', 'teams.write', 'assets.read', 'assets.write',
    'imagery.read', 'imagery.write', 'reports.read', 'reports.write',
    'sync.read', 'sync.submit'
  ],
  scout: [
    'gis.read', 'campaigns.read', 'scouting.read',
    'scouting.observe', 'scouting.evidence', 'water.write', 'sync.submit'
  ],
  contractor: ['orders.read', 'orders.execute'],
  producer_viewer: ['gis.read']
});

export function hasCapability(auth, tenantId, capability) {
  const membership = auth?.membership;
  const roleCode = auth?.role?.code;
  if (!tenantId || !auth?.user?.id || !membership || !roleCode || !capability) return false;
  if (membership.status !== 'active' || membership.tenant_id !== tenantId ||
      membership.user_id !== auth.user.id || membership.role_code !== roleCode) return false;
  const allowed = Object.hasOwn(CAPABILITIES, roleCode) ? CAPABILITIES[roleCode] : null;
  return Boolean(Array.isArray(allowed) && (allowed.includes('*') || allowed.includes(capability)));
}

export function requireCapability(capability) {
  return (req, _res, next) => {
    if (!hasCapability(req.auth, req.tenantId, capability)) {
      return next(new HttpError(403, 'No tenés permisos suficientes para realizar esta acción.', undefined, 'CAPABILITY_DENIED'));
    }
    next();
  };
}
