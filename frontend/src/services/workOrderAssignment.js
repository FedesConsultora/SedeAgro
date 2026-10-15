// Presentation only: server capabilities, membership checks and order row locks
// are the authority for creating assignments.
export const ORDER_ASSIGNMENT_ROLES = Object.freeze([
  'tenant_admin', 'agronomic_coordinator', 'contractor'
]);
const PLANNING_STATES = new Set(['draft', 'pending_approval', 'approved']);

export function canManageWorkOrderAssignments(order, roleCode, live) {
  return Boolean(live && order && PLANNING_STATES.has(order.status) &&
    (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator'));
}

export function eligibleWorkOrderMembers(response, assignees = []) {
  if (!Array.isArray(response?.data)) {
    throw new Error('No se recibió un directorio válido de responsables.');
  }
  const assigned = new Set(assignees.map(item => item.user_id));
  return response.data.filter(membership =>
    membership?.status === 'active' && membership.User?.status === 'active' &&
    ORDER_ASSIGNMENT_ROLES.includes(membership.role_code) &&
    typeof membership.user_id === 'string' &&
    !assigned.has(membership.user_id)
  ).map(membership => ({
    id: membership.user_id,
    name: membership.User.full_name || membership.User.email || 'Integrante sin nombre',
    role: membership.role_code
  })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export function validateWorkOrderAssignmentResponse(response, orderId, userId) {
  if (response?.data?.work_order_id !== orderId || response?.data?.user_id !== userId ||
      typeof response?.data?.id !== 'string') {
    throw new Error('El servidor no confirmó la asignación solicitada. Actualizá la orden.');
  }
  return response.data;
}
