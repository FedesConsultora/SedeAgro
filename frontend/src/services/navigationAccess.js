// Frontend navigation mirrors coarse backend RBAC; API capability checks
// remain the authority. Entitlements grant modules, never role permissions.
const VIEW_ACCESS = Object.freeze({
  dashboard: { roles: ['tenant_admin', 'agronomic_coordinator', 'scout', 'contractor', 'producer_viewer'] },
  fields: { entitlement: 'gis', roles: ['tenant_admin', 'agronomic_coordinator', 'scout', 'producer_viewer'] },
  teams: { entitlement: 'org', roles: ['tenant_admin', 'agronomic_coordinator'] },
  campaigns: { entitlement: 'campaigns', roles: ['tenant_admin', 'agronomic_coordinator', 'scout'] },
  scouting: { entitlement: 'scouting', roles: ['tenant_admin', 'agronomic_coordinator', 'scout'] },
  orders: { entitlement: 'work_orders', roles: ['tenant_admin', 'agronomic_coordinator', 'contractor'] },
  assets: { entitlement: 'work_orders', roles: ['tenant_admin', 'agronomic_coordinator'] },
  reports: { entitlement: 'reports', roles: ['tenant_admin', 'agronomic_coordinator'] },
  imagery: { entitlement: 'imagery', roles: ['tenant_admin', 'agronomic_coordinator'] },
  sync: { entitlement: 'scouting', roles: ['tenant_admin', 'agronomic_coordinator', 'scout'] },
  sessions: { roles: ['tenant_admin', 'agronomic_coordinator', 'scout', 'contractor', 'producer_viewer'] },
  admin: { roles: ['tenant_admin'] },
  platform: { roles: ['tenant_admin', 'agronomic_coordinator', 'scout', 'contractor', 'producer_viewer'], platformAdmin: true }
});

export function canNavigateView(viewId, { entitlements = [], role = '', platformAdmin = false } = {}) {
  const rule = VIEW_ACCESS[viewId];
  if (!rule || !rule.roles.includes(role)) return false;
  if (rule.entitlement && !entitlements.includes(rule.entitlement)) return false;
  if (rule.platformAdmin && !platformAdmin) return false;
  return true;
}
