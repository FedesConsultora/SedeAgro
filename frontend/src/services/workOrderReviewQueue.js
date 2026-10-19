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

// Global review-state group vocabulary; the backend filters before SQL LIMIT.
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

// All criteria (work type, review state, priority, due window and title) are evaluated
// by the authorized backend before keyset pagination; never filter only 50 rows.
export const REVIEW_QUEUE_WORK_TYPES = Object.freeze({
  all: 'Todas las labores',
  application: 'Aplicación',
  sowing: 'Siembra',
  fertilization: 'Fertilización',
  harvest: 'Cosecha',
  irrigation: 'Riego',
  inspection: 'Inspección',
  other: 'Otra labor'
});

export const REVIEW_QUEUE_PRIORITIES = Object.freeze({
  all: 'Todas las prioridades',
  urgent: 'Urgente',
  high: 'Alta',
  normal: 'Normal',
  low: 'Baja'
});

export const REVIEW_QUEUE_DUE_WINDOWS = Object.freeze({
  all: 'Cualquier vencimiento',
  overdue: 'Vencidas',
  next_7_days: 'Próximas 168 horas',
  later: 'Posteriores a 168 horas',
  unscheduled: 'Sin fecha de vencimiento'
});

export const REVIEW_QUEUE_SORT_MODES = Object.freeze({
  newest: 'Más recientes primero',
  due_first: 'Vencimiento más próximo',
  priority_first: 'Mayor prioridad primero'
});

export const REVIEW_TITLE_QUERY_MAX_CODEPOINTS = 64;
export function normalizeReviewTitleQuery(input) {
  if (typeof input !== 'string') throw new Error('Texto de búsqueda inválido.');
  const query = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = Array.from(query).length;
  if (query && (length < 2 || length > REVIEW_TITLE_QUERY_MAX_CODEPOINTS ||
      /[\p{Cc}\p{Cf}]/u.test(query))) {
    throw new Error('Texto de búsqueda inválido.');
  }
  return query;
}
const isCanonicalTitleQuery = input => {
  try { return normalizeReviewTitleQuery(input) === input; }
  catch { return false; }
};

export function reviewQueueUrl(cursor = null, workType = 'all', reviewState = 'all', priority = 'all', dueWindow = 'all', titleQuery = '', sortMode = 'newest') {
  if (!Object.hasOwn(REVIEW_QUEUE_WORK_TYPES, workType) ||
      !Object.hasOwn(REVIEW_QUEUE_PAGE_FILTERS, reviewState) ||
      !Object.hasOwn(REVIEW_QUEUE_PRIORITIES, priority) ||
      !Object.hasOwn(REVIEW_QUEUE_DUE_WINDOWS, dueWindow) ||
      !isCanonicalTitleQuery(titleQuery) ||
      !Object.hasOwn(REVIEW_QUEUE_SORT_MODES, sortMode)) {
    throw new Error('Filtro global de labor inválido.');
  }
  const query = new URLSearchParams();
  if (cursor !== null) query.set('cursor', cursor);
  if (workType !== 'all') query.set('type', workType);
  if (reviewState !== 'all') query.set('state', reviewState);
  if (priority !== 'all') query.set('priority', priority);
  if (dueWindow !== 'all') query.set('due', dueWindow);
  if (titleQuery) query.set('q', titleQuery);
  if (sortMode !== 'newest') query.set('sort', sortMode);
  return '/work-orders/review-queue' +
    (query.size ? '?' + query.toString() : '');
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

export function reviewQueueRequestKey(page, cursor, reload, workType = 'all', reviewState = 'all', priority = 'all', dueWindow = 'all', titleQuery = '', sortMode = 'newest') {
  if (!Number.isSafeInteger(page) || page < 0 ||
      !Number.isSafeInteger(reload) || reload < 0 ||
      (cursor !== null && typeof cursor !== 'string') ||
      !Object.hasOwn(REVIEW_QUEUE_WORK_TYPES, workType) ||
      !Object.hasOwn(REVIEW_QUEUE_PAGE_FILTERS, reviewState) ||
      !Object.hasOwn(REVIEW_QUEUE_PRIORITIES, priority) ||
      !Object.hasOwn(REVIEW_QUEUE_DUE_WINDOWS, dueWindow) ||
      !isCanonicalTitleQuery(titleQuery) ||
      !Object.hasOwn(REVIEW_QUEUE_SORT_MODES, sortMode)) {
    throw new Error('Navegación de revisión inválida.');
  }
  return JSON.stringify([page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode]);
}
