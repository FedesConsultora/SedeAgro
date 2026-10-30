import { validateWorkOrderDetail } from './workOrderDetails.js';

// A network failure is not evidence of a failed write: PostgreSQL may have
// committed and the browser may have lost only the HTTP acknowledgement.
// This GET reconciliation never retries the POST or certifies physical work.
export function needsExecutionReceiptLookup(error) {
  return !error || error.status == null || error.status === 0 ||
    (error.status === 409 && error.code === 'EXECUTION_ALREADY_SUBMITTED');
}

function sameInstant(left, right) {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function sameExecutionDeclaration(report, payload, orderId, actorId) {
  const amount = Number(report?.worked_area_hectares);
  return typeof report?.id === 'string' && Boolean(report.id) &&
    report.work_order_id === orderId && report.submitted_by === actorId &&
    ['submitted', 'verified', 'rejected'].includes(report.review_status) &&
    sameInstant(report.started_at, payload.started_at) &&
    sameInstant(report.finished_at, payload.finished_at) &&
    Number.isFinite(amount) && Math.abs(amount - payload.worked_area_hectares) < 0.000001 &&
    report.result_summary === payload.result_summary;
}

// Only a current, authorized GET of the SAME order can establish that a
// persisted declaration exists. If records cannot be distinguished, fail
// closed rather than marking the interrupted POST as successful.
export function reconcileExecutionReceipt(response, { orderId, actorId, payload }) {
  if (!orderId || !actorId || !payload) {
    throw new Error('Falta la identidad necesaria para comprobar el parte.');
  }
  const order = validateWorkOrderDetail(response, orderId);
  if (!Array.isArray(order.WorkOrderExecutions) || order.WorkOrderExecutions.some(report =>
    !report || typeof report.id !== 'string' || report.work_order_id !== orderId)) {
    throw new Error('El servidor no devolvió un historial de partes válido.');
  }
  const matches = order.WorkOrderExecutions.filter(report =>
    sameExecutionDeclaration(report, payload, orderId, actorId));
  if (matches.length === 1) {
    return { state: 'recorded', reportId: matches[0].id, order };
  }
  if (matches.length > 1) return { state: 'ambiguous', order };
  if (order.WorkOrderExecutions.some(report =>
    report.review_status === 'submitted' || report.review_status === 'verified')) {
    return { state: 'different', order };
  }
  return { state: 'unconfirmed', order };
}
