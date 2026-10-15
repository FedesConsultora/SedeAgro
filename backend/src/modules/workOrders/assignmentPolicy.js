// Order row locks serialize assignment creation with lifecycle transitions.
// The existing relationship remains immutable once operational execution begins.
export const ASSIGNABLE_WORK_ORDER_STATES = Object.freeze(['draft', 'pending_approval', 'approved']);

export function canAddWorkOrderAssignee(status) {
  return ASSIGNABLE_WORK_ORDER_STATES.includes(status);
}

// Entitlement and role permissions are enforced by the router. Before moving
// to assigned, at least one existing assignee must still have an active tenant
// membership, eligible role, and active user account.
export function hasActiveWorkOrderExecutor(assigneeUserIds, eligibleUserIds) {
  const active = new Set(eligibleUserIds);
  return assigneeUserIds.some(id => active.has(id));
}

// Clients can supply x-request-id. Never persist an untrusted value into a
// PostgreSQL uuid audit column or turn an otherwise valid write into HTTP 500.
export function safeAuditRequestId(value) {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value : null;
}
