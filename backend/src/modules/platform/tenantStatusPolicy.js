// Tenant suspension is not a delete. All previous session JTIs must be
// revoked BEFORE a suspended tenant can ever be restored to active.
export function planTenantStatusChange({
  actorTenantId, targetTenantId, previousStatus, nextStatus, planChangeRequested = false
}) {
  if (!actorTenantId || !targetTenantId) {
    return { allowed: false, code: 'TENANT_STATUS_CONTEXT_INVALID' };
  }
  if (previousStatus === 'deleted' && (nextStatus !== 'deleted' || planChangeRequested)) {
    return { allowed: false, code: 'TENANT_DELETED_TERMINAL' };
  }
  if (nextStatus !== undefined &&
      !['active','onboarding','suspended','deleted'].includes(nextStatus)) {
    return { allowed: false, code: 'TENANT_STATUS_INVALID' };
  }
  if (actorTenantId === targetTenantId && ['suspended','deleted'].includes(nextStatus)) {
    // The only active platform-admin session may belong to this tenant.
    // Require a different platform company to perform global lockout.
    return { allowed: false, code: 'TENANT_SELF_LOCKOUT_FORBIDDEN' };
  }
  return {
    allowed: true,
    revokeSessions: nextStatus === 'suspended' || nextStatus === 'deleted',
    statusChanged: nextStatus !== undefined && nextStatus !== previousStatus
  };
}
