// Platform control of a global login identity is separate from every
// tenant's own membership lifecycle and role assignment.
export function globalUserStatusDecision(actor, target, nextStatus) {
  if (!actor?.id || actor.is_platform_admin !== true || !target?.id) {
    return { allowed: false, code: 'PLATFORM_USER_STATUS_FORBIDDEN' };
  }
  if (target.id === actor.id || target.is_platform_admin === true) {
    // An admin must not lock itself or another platform operator out via
    // a tenant-scoped session. Escalation/offboarding requires separate review.
    return { allowed: false, code: 'PLATFORM_ADMIN_PROTECTED' };
  }
  if (!['active', 'blocked'].includes(nextStatus)) {
    return { allowed: false, code: 'PLATFORM_USER_STATUS_INVALID' };
  }
  if (target.status === 'deleted') {
    // Soft-deleted accounts are not silently recreated by a status toggle.
    return { allowed: false, code: 'PLATFORM_USER_DELETED' };
  }
  if (!['active', 'blocked'].includes(target.status)) {
    return { allowed: false, code: 'PLATFORM_USER_STATUS_UNSUPPORTED' };
  }
  return { allowed: true, changed: target.status !== nextStatus };
}
