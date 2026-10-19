import { REVIEW_QUEUE_WORK_TYPES, REVIEW_QUEUE_PAGE_FILTERS,
  REVIEW_QUEUE_PRIORITIES, REVIEW_QUEUE_DUE_WINDOWS,
  REVIEW_QUEUE_SORT_MODES, normalizeReviewTitleQuery
} from './workOrderReviewQueue.js';

export const REVIEW_VIEW_LIMIT = 10;
export const REVIEW_VIEWS_PATH = '/work-orders/review-queue/views';
const isKnown = (items, value) =>
  typeof value === 'string' && Object.hasOwn(items, value);

export function normalizeReviewViewName(value) {
  if (typeof value !== 'string') throw new Error('Nombre de vista inválido.');
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (name.length < 2 || name.length > 48 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error('Nombre de vista inválido.');
  }
  return name;
}

export function reviewViewFilters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
      'dueWindow,priority,reviewState,sortMode,titleQuery,workType' ||
      !isKnown(REVIEW_QUEUE_WORK_TYPES, value.workType) ||
      !isKnown(REVIEW_QUEUE_PAGE_FILTERS, value.reviewState) ||
      !isKnown(REVIEW_QUEUE_PRIORITIES, value.priority) ||
      !isKnown(REVIEW_QUEUE_DUE_WINDOWS, value.dueWindow) ||
      !isKnown(REVIEW_QUEUE_SORT_MODES, value.sortMode) ||
      typeof value.titleQuery !== 'string') {
    throw new Error('Los filtros de la vista no son válidos.');
  }
  let canonical;
  try { canonical = normalizeReviewTitleQuery(value.titleQuery); }
  catch { throw new Error('Los filtros de la vista no son válidos.'); }
  if (canonical !== value.titleQuery) throw new Error('Los filtros de la vista no son válidos.');
  return {workType:value.workType,reviewState:value.reviewState,
    priority:value.priority,dueWindow:value.dueWindow,
    titleQuery:value.titleQuery,sortMode:value.sortMode};
}
export function validateSavedViews(response) {
  const rows = response?.data;
  if (!Array.isArray(rows) || rows.length > REVIEW_VIEW_LIMIT ||
      !rows.every(row => row && typeof row.id === 'string' &&
        typeof row.name === 'string' && row.name.length >= 2 &&
        row.name.length <= 48 && Boolean(reviewViewFilters(row.filters)))) {
    throw new Error('La respuesta de vistas guardadas no es válida.');
  }
  return rows;
}
export function validateSavedView(response) {
  const [row] = validateSavedViews({data:[response?.data]});
  return row;
}
