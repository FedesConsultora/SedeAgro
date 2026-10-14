// Presentation policy only. Server authorization and workflow locking are
// authoritative: backend/src/modules/workOrders/workOrderPolicy.js.
export const WORK_ORDER_STATUS_LABELS = Object.freeze({
  draft: 'Borrador',
  pending_approval: 'Pend. aprobación',
  approved: 'Aprobado',
  assigned: 'Asignado',
  in_progress: 'En curso',
  completed: 'Completado',
  cancelled: 'Cancelado'
});

const EDGES = Object.freeze({
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'draft', 'cancelled'],
  approved: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
});

export function validateWorkOrderDetail(response, expectedId) {
  const order = response?.data;
  if (!order || typeof order !== 'object' || Array.isArray(order) ||
      order.id !== expectedId || !Object.hasOwn(EDGES, order.status) ||
      !Array.isArray(order.WorkOrderAssignees)) {
    throw new Error('El servidor devolvió un detalle de orden inválido.');
  }
  return order;
}

export function availableWorkOrderTransitions(order, roleCode, userId, live = false) {
  if (!live || !order || !userId || !Object.hasOwn(EDGES, order.status)) return [];
  const edges = EDGES[order.status];
  if (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator') {
    // The backend requires an assignee before approving the assigned state.
    return edges.filter(status => status !== 'assigned' ||
      (Array.isArray(order.WorkOrderAssignees) && order.WorkOrderAssignees.length > 0));
  }
  if (roleCode !== 'contractor' || !Array.isArray(order.WorkOrderAssignees) ||
      !order.WorkOrderAssignees.some(item => item.user_id === userId)) return [];
  return edges.filter(status =>
    (order.status === 'assigned' && status === 'in_progress') ||
    (order.status === 'in_progress' && status === 'completed'));
}
