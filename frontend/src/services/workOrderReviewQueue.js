// No heuristics from the list view: only accept a server-authored,
// tenant-scoped summary. A review candidate is NOT an approved report.
export const REVIEW_QUEUE_STATES = Object.freeze({
  awaiting_report: 'Sin parte presentado',
  self_authored: 'Requiere otro revisor',
  awaiting_inputs: 'Falta declaración de insumos',
  rejected_exception: 'Excepción rechazada',
  pending_exception: 'Excepción pendiente',
  awaiting_evidence: 'Falta respaldo privado',
  human_review: 'Para revisión humana',
  ready_for_closure: 'Parte verificado; evaluar cierre'
});

export function validateReviewQueue(response, expectedPage = 0) {
  const { data, pagination } = response || {};
  if (!Array.isArray(data) || data.length > 50 || !pagination ||
    pagination.page !== expectedPage || pagination.page_size !== 50 ||
    typeof pagination.has_more !== 'boolean' ||
    !data.every(item => item && typeof item.id === 'string' &&
      typeof item.title === 'string' && typeof item.type === 'string' &&
      item.status === 'in_progress' && typeof item.reason === 'string' &&
      Object.hasOwn(REVIEW_QUEUE_STATES, item.state) &&
      (item.report_id === null || typeof item.report_id === 'string'))) {
    throw new Error('La respuesta de pendientes de coordinación no es válida.');
  }
  return { items: data, page: pagination.page, hasMore: pagination.has_more };
}

export function isCoordinationReviewer(role, dataMode, authenticated) {
  return dataMode === 'live' && authenticated === true &&
    (role === 'tenant_admin' || role === 'agronomic_coordinator');
}
