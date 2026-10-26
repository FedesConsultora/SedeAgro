// Only existing, previously granted non-admin tenant roles can be
// reactivated. Status changes never alter a role or infer new membership.
export const MANAGED_MEMBER_ROLES = Object.freeze([
  'agronomic_coordinator', 'scout', 'contractor', 'producer_viewer'
]);

export function isManageableMembership(membership, actorId, tenantId) {
  return Boolean(membership && actorId && tenantId &&
    membership.tenant_id === tenantId &&
    membership.user_id !== actorId &&
    MANAGED_MEMBER_ROLES.includes(membership.role_code) &&
    ['active', 'blocked'].includes(membership.status));
}

export function hasSeatForActivation({ active, pending, maxUsers }) {
  return Number.isSafeInteger(active) && active >= 0 &&
    Number.isSafeInteger(pending) && pending >= 0 &&
    Number.isSafeInteger(maxUsers) && maxUsers > 0 &&
    active + pending < maxUsers;
}

export function membershipStatusReceipt(membership, changed) {
  return {
    id: membership.id,
    tenant_id: membership.tenant_id,
    user_id: membership.user_id,
    role_code: membership.role_code,
    status: membership.status,
    changed
  };
}
