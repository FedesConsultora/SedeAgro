// Route hints are identifiers, not authorization. Reject contradictory
// explicit hints BEFORE selecting the tenant transaction/context.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantHintProblem({
  hostSlug, headerSlug, headerId, resolvedTenantId
} = {}) {
  if (headerSlug !== undefined && headerSlug !== '' &&
      typeof headerSlug !== 'string') return 'TENANT_SLUG_INVALID';
  if (headerId !== undefined && headerId !== '' &&
      (typeof headerId !== 'string' || !UUID.test(headerId))) {
    return 'TENANT_ID_INVALID';
  }
  if (hostSlug && headerSlug && hostSlug !== headerSlug) {
    return 'TENANT_HINT_CONFLICT';
  }
  if (resolvedTenantId && headerId &&
      resolvedTenantId.toLowerCase() !== headerId.toLowerCase()) {
    return 'TENANT_HINT_CONFLICT';
  }
  return null;
}
