import { z } from 'zod';
import { REVIEW_QUEUE_WORK_TYPES, REVIEW_QUEUE_STATE_FILTERS,
  REVIEW_QUEUE_PRIORITIES } from './reviewQueueCursor.js';
import { REVIEW_QUEUE_DUE_WINDOWS } from './reviewQueueDueWindow.js';
import { REVIEW_QUEUE_SORT_MODES } from './reviewQueueSorting.js';
import { normalizeReviewTitleQuery } from './reviewQueueTitleSearch.js';

export const REVIEW_VIEW_LIMIT = 10;
export const SHARED_REVIEW_VIEW_LIMIT = 20;
export const REVIEW_VIEW_VISIBILITIES = Object.freeze(['private','shared']);
const exactEnum = values => z.enum([...values]);
const titleQuery = z.string().max(128).refine(
  value => {
    try { return normalizeReviewTitleQuery(value) === value; }
    catch { return false; }
  },
  'La búsqueda guardada debe estar normalizada.'
);

export const reviewViewFiltersSchema = z.object({
  workType: exactEnum(REVIEW_QUEUE_WORK_TYPES),
  reviewState: exactEnum(REVIEW_QUEUE_STATE_FILTERS),
  priority: exactEnum(REVIEW_QUEUE_PRIORITIES),
  dueWindow: exactEnum(REVIEW_QUEUE_DUE_WINDOWS),
  titleQuery,
  sortMode: exactEnum(REVIEW_QUEUE_SORT_MODES)
}).strict();

const normalizeName = value =>
  typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : value;
export const reviewViewSchema = z.object({
  name: z.string().transform(normalizeName)
    .pipe(z.string().min(2).max(48).regex(/^[^\p{Cc}\p{Cf}]+$/u)),
  filters: reviewViewFiltersSchema
}).strict();

export function parseReviewView(input) {
  const parsed = reviewViewSchema.safeParse(input);
  if (!parsed.success) throw new Error('Vista guardada inválida.');
  return parsed.data;
}

export function publicReviewView(value, userId) {
  return {
    id:value.id, name:value.name, filters:value.filters,
    created_at:value.created_at, updated_at:value.updated_at,
    visibility:value.visibility, source:value.user_id === userId ? 'mine' : 'shared'
  };
}

export function isValidSavedReviewView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = reviewViewFiltersSchema.safeParse(value.filters);
  return typeof value.id === 'string' && typeof value.name === 'string' &&
    REVIEW_VIEW_VISIBILITIES.includes(value.visibility) && data.success;
}
