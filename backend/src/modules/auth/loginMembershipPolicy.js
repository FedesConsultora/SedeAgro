// Public login only receives tenant choices AFTER password and global status
// verification. If both selectors are supplied, they must identify the SAME
// authorized tenant; never use OR, which could silently switch organizations.
export function selectLoginMembership(activeMemberships, { tenantId, tenantSlug } = {}) {
  if (!Array.isArray(activeMemberships)) return null;
  if (tenantId || tenantSlug) {
    return activeMemberships.find(membership =>
      (!tenantId || membership?.tenant_id === tenantId) &&
      (!tenantSlug || membership?.Tenant?.slug === tenantSlug)
    ) || null;
  }
  return activeMemberships.length === 1 ? activeMemberships[0] : null;
}
