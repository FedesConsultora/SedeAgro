import { Op, col, fn, literal, where } from 'sequelize';

export const REVIEW_QUEUE_SORT_MODES = Object.freeze([
  'newest', 'due_first', 'priority_first'
]);
const PRIORITY_RANK = Object.freeze({ urgent: 0, high: 1, normal: 2, low: 3 });
const priorityExpression = () => literal(
  'CASE "WorkOrder"."priority" WHEN \'urgent\' THEN 0 ' +
  'WHEN \'high\' THEN 1 WHEN \'normal\' THEN 2 WHEN \'low\' THEN 3 ELSE 4 END'
);
const dueExpression = () => fn('date_trunc', 'milliseconds', col('due_at'));
const validSort = mode => REVIEW_QUEUE_SORT_MODES.includes(mode);
const createdExpression = () => fn('date_trunc', 'milliseconds', col('created_at'));

export function reviewQueueSortKey(mode, order) {
  if (!validSort(mode)) throw new Error('Orden de revisión inválido.');
  if (mode === 'newest') return null;
  if (mode === 'priority_first') return PRIORITY_RANK[order?.priority] ?? 4;
  if (order?.due_at == null) return null;
  const date = order.due_at instanceof Date ? order.due_at : new Date(order.due_at);
  if (!Number.isFinite(date.getTime())) throw new Error('Vencimiento inválido.');
  return date.toISOString();
}

export function isValidReviewSortKey(mode, key) {
  if (!validSort(mode)) return false;
  if (mode === 'newest') return key === null;
  if (mode === 'priority_first') return Number.isInteger(key) && key >= 0 && key <= 4;
  return key === null || (typeof key === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(key) &&
    Number.isFinite(Date.parse(key)) && new Date(key).toISOString() === key);
}

export function reviewQueueSortOrder(mode) {
  if (!validSort(mode)) throw new Error('Orden de revisión inválido.');
  const tie = [[createdExpression(), 'DESC'], ['id', 'DESC']];
  if (mode === 'newest') return tie;
  return [
    [mode === 'priority_first' ? priorityExpression() : dueExpression(),
      mode === 'priority_first' ? 'ASC' : 'ASC NULLS LAST'],
    ...tie
  ];
}

export function reviewQueueOlderWhere(mode, cursor) {
  if (!validSort(mode) || !cursor || !isValidReviewSortKey(mode, cursor.sortKey)) {
    throw new Error('Continuación de orden inválida.');
  }
  const tie = [
    where(createdExpression(), { [Op.lt]: cursor.lastDate }),
    { [Op.and]: [
      where(createdExpression(), { [Op.eq]: cursor.lastDate }),
      { id: { [Op.lt]: cursor.lastId } }
    ] }
  ];
  if (mode === 'newest') return { [Op.or]: tie };
  const expression = mode === 'priority_first' ? priorityExpression() : dueExpression();
  if (mode === 'due_first' && cursor.sortKey === null) {
    return { [Op.and]: [
      where(expression, { [Op.is]: null }), { [Op.or]: tie }
    ] };
  }
  const key = mode === 'due_first' ? new Date(cursor.sortKey) : cursor.sortKey;
  const clauses = [
    where(expression, { [Op.gt]: key }),
    { [Op.and]: [
      where(expression, { [Op.eq]: key }), { [Op.or]: tie }
    ] }
  ];
  if (mode === 'due_first') clauses.push(where(expression, { [Op.is]: null }));
  return { [Op.or]: clauses };
}
