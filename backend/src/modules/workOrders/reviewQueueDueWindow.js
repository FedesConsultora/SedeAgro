import { Op } from 'sequelize';

// Categories are anchored to the first server query; a cursor never uses a
// moving Date.now() boundary while traversing a tenant-authorized result set.
export const REVIEW_QUEUE_DUE_WINDOWS = Object.freeze([
  'all', 'overdue', 'next_7_days', 'later', 'unscheduled'
]);
export const REVIEW_QUEUE_DUE_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

export function reviewQueueDueWhere(window, anchor) {
  if (!REVIEW_QUEUE_DUE_WINDOWS.includes(window) ||
      !(anchor instanceof Date) || !Number.isFinite(anchor.getTime())) {
    throw new Error('Invalid review queue due-window scope');
  }
  const end = new Date(anchor.getTime() + REVIEW_QUEUE_DUE_SPAN_MS);
  if (!Number.isFinite(end.getTime())) throw new Error('Invalid due-window endpoint');
  switch (window) {
    case 'all': return {};
    case 'overdue': return { due_at: { [Op.lt]: anchor } };
    case 'next_7_days': return { due_at: { [Op.gte]: anchor, [Op.lt]: end } };
    case 'later': return { due_at: { [Op.gte]: end } };
    case 'unscheduled': return { due_at: { [Op.is]: null } };
    default: throw new Error('Invalid review queue due-window scope');
  }
}
