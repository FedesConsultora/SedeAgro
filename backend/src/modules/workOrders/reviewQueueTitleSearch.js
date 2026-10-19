import { Op, fn, col, where } from 'sequelize';

// Search ONLY the public work_order title, never private reports or evidence.
// Exact literal substring: PostgreSQL strpos does NOT interpret % or _ as wildcards.
export const REVIEW_TITLE_QUERY_MAX_CODEPOINTS = 64;

export function normalizeReviewTitleQuery(input) {
  if (typeof input !== 'string') throw new Error('Texto de búsqueda inválido.');
  const query = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (query === '') return '';
  const length = Array.from(query).length;
  if (length < 2 || length > REVIEW_TITLE_QUERY_MAX_CODEPOINTS ||
      /[\p{Cc}\p{Cf}]/u.test(query)) {
    throw new Error('Texto de búsqueda inválido.');
  }
  return query;
}

export function reviewQueueTitleWhere(query) {
  if (normalizeReviewTitleQuery(query) !== query || !query) {
    throw new Error('Texto de búsqueda inválido.');
  }
  // Sequelize treats query as a VALUE, never an interpolated SQL fragment.
  return where(fn('strpos', fn('lower', col('title')), fn('lower', query)),
    { [Op.gt]: 0 });
}
