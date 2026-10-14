// Only legal workflow edges are accepted, even for tenant administrators.
// Contractors can advance execution on orders explicitly assigned to them.
export const WORK_ORDER_TRANSITIONS = Object.freeze({
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'draft', 'cancelled'],
  approved: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
});

export function canTransitionWorkOrder(current, next, roleCode, assignedToActor = false) {
  if (!WORK_ORDER_TRANSITIONS[current]?.includes(next)) return false;
  if (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator') return true;
  return roleCode === 'contractor' && assignedToActor &&
    ((current === 'assigned' && next === 'in_progress') ||
     (current === 'in_progress' && next === 'completed'));
}
