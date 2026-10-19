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

// Client-only grouping of the ALREADY AUTHORIZED current page. This is not
// a backend search and must never hide or modify the server pagination cursor.
export const REVIEW_QUEUE_PAGE_FILTERS = Object.freeze({
  all: Object.freeze({ label: 'Todas', states: null }),
  no_report: Object.freeze({ label: 'Sin parte', states: ['awaiting_report'] }),
  blocked: Object.freeze({ label: 'Con bloqueos', states: [
    'self_authored', 'awaiting_inputs', 'rejected_exception',
    'pending_exception', 'awaiting_evidence'
  ] }),
  review: Object.freeze({ label: 'Revisión humana', states: ['human_review'] }),
  closure: Object.freeze({ label: 'Posible cierre', states: ['ready_for_closure'] })
});

export function filterReviewQueuePage(items, filter = 'all') {
  if (!Array.isArray(items) || !Object.hasOwn(REVIEW_QUEUE_PAGE_FILTERS, filter)) {
    throw new Error('Filtro de pendientes inválido.');
  }
  const states = REVIEW_QUEUE_PAGE_FILTERS[filter].states;
  return states === null ? items : items.filter(item => states.includes(item.state));
}

export function reviewQueueUrl(cursor = null) {
  return '/work-orders/review-queue' +
    (cursor == null ? '' : `?cursor=${encodeURIComponent(cursor)}`);
}

export function validateReviewQueue(response) {
  const { data, pagination } = response || {};
  if (!Array.isArray(data) || data.length > 50 || !pagination ||
    pagination.page_size !== 50 ||
    typeof pagination.has_more !== 'boolean' ||
    (pagination.has_more && (typeof pagination.next_cursor !== 'string' ||
      pagination.next_cursor.length < 40 || pagination.next_cursor.length > 1024)) ||
    (!pagination.has_more && pagination.next_cursor !== null) ||
    !data.every(item => item && typeof item.id === 'string' &&
      typeof item.title === 'string' && typeof item.type === 'string' &&
      item.status === 'in_progress' && typeof item.reason === 'string' &&
      Object.hasOwn(REVIEW_QUEUE_STATES, item.state) &&
      (item.report_id === null || typeof item.report_id === 'string'))) {
    throw new Error('La respuesta de pendientes de coordinación no es válida.');
  }
  return { items: data, hasMore: pagination.has_more,
    nextCursor: pagination.next_cursor };
}

export function isCoordinationReviewer(role, dataMode, authenticated) {
  return dataMode === 'live' && authenticated === true &&
    (role === 'tenant_admin' || role === 'agronomic_coordinator');
}

/**
 * A rejected cursor is not a transient request failure: sending it again
 * cannot recover it. Never expose the signed cursor in UI messages.
 */
export function reviewQueueFailure(error, usedCursor) {
  const expired = usedCursor && error?.status === 422 &&
    error?.code === 'ORDER_REVIEW_CURSOR_INVALID';
  if (expired) return {
    expired: true,
    message: 'El recorrido de pendientes venció o dejó de ser válido. Iniciá una consulta nueva.'
  };
  return { expired: false,
    message: error?.message || 'No se pudo consultar la bandeja de revisión.' };
}

export function reviewQueueRequestKey(page, cursor, reload) {
  if (!Number.isSafeInteger(page) || page < 0 ||
      !Number.isSafeInteger(reload) || reload < 0 ||
      (cursor !== null && typeof cursor !== 'string')) {
    throw new Error('Navegación de revisión inválida.');
  }
  return JSON.stringify([page, cursor, reload]);
}
