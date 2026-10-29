import { Op } from 'sequelize';
import { sequelize, setLocalTenant } from '../../core/db.js';
import { Membership, Tenant } from '../../models/index.js';
import { HttpError } from '../../utils/http.js';

// Intentionally bounded for the first real pilot: unbounded N-tenant scans
// make password-authenticated public login a DB DoS. An explicit tenant
// selector is O(1); without one, every candidate is queried with its own RLS
// GUC inside ONE database transaction (no bypass role, view or definer).
export const MAX_LOGIN_DISCOVERY_TENANTS = 250;

export function loginDiscoveryTenantWhere({ tenantId, tenantSlug } = {}) {
  return {
    status: { [Op.in]: ['onboarding', 'active'] },
    ...(tenantId ? { id: tenantId } : {}),
    ...(tenantSlug ? { slug: tenantSlug } : {})
  };
}

export async function discoverLoginMemberships(userId, selectors = {}) {
  if (typeof userId !== 'string' || !/^[a-f0-9-]{36}$/i.test(userId)) {
    throw new HttpError(401, 'Sesión inválida.');
  }
  const explicit = Boolean(selectors.tenantId || selectors.tenantSlug);
  const tenants = await Tenant.findAll({
    where: loginDiscoveryTenantWhere(selectors),
    attributes: ['id', 'name', 'slug', 'status'],
    order: [['id', 'ASC']],
    limit: explicit ? 1 : MAX_LOGIN_DISCOVERY_TENANTS + 1,
    skipTenantScope: true
  });
  if (!explicit && tenants.length > MAX_LOGIN_DISCOVERY_TENANTS) {
    // Do not silently omit organizations or weaken FORCE RLS for scale.
    // Requires an approved indexed/privilege-minimal discovery design.
    throw new HttpError(503, 'El inicio multiempresa necesita configuración adicional.',
      undefined, 'LOGIN_DISCOVERY_CAPACITY_LIMIT');
  }
  if (!tenants.length) return [];
  return sequelize.transaction(async transaction => {
    const matches = [];
    for (const tenant of tenants) {
      await setLocalTenant(transaction, tenant.id);
      const member = await Membership.findOne({
        where: { tenant_id: tenant.id, user_id: userId, status: 'active' },
        attributes: ['id', 'tenant_id', 'user_id', 'role_code', 'status'],
        transaction,
        skipTenantScope: true
      });
      if (member) {
        // Only IDs, role and the already-authorized tenant choices leave the
        // discovery boundary. No user email, secret, invitation or row payload.
        matches.push({
          id: member.id, tenant_id: member.tenant_id,
          role_code: member.role_code, status: member.status,
          Tenant: { id: tenant.id, name: tenant.name,
            slug: tenant.slug, status: tenant.status }
        });
      }
    }
    return matches;
  });
}
