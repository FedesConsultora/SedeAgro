import { validateWorkOrderDetail } from './workOrderDetails.js';

// A lost HTTP response does not establish whether the transactional review
// committed. A GET under the current authenticated actor is the only receipt.
// Never repeat a review POST automatically, and never claim physical proof.
export function needsReviewReceiptLookup(error) {
  return !error || error.status == null || error.status === 0 ||
    [500, 502, 503, 504].includes(error.status) ||
    (error.status === 409 && [
      'EXECUTION_ALREADY_REVIEWED', 'EXECUTION_REVIEW_CLOSED'
    ].includes(error.code));
}

const CHECKS = Object.freeze([
  'time_checked', 'area_checked', 'result_checked',
  'operation_checked', 'evidence_basis'
]);

function sameChecklist(actual, expected) {
  return actual && typeof actual === 'object' && !Array.isArray(actual) &&
    expected && typeof expected === 'object' && !Array.isArray(expected) &&
    Object.keys(actual).length === CHECKS.length &&
    Object.keys(expected).length === CHECKS.length &&
    CHECKS.every(key => Object.hasOwn(actual, key) &&
      Object.hasOwn(expected, key) && actual[key] === expected[key]) &&
    CHECKS.slice(0, 4).every(key => actual[key] === true) &&
    ['reviewed_files', 'no_files'].includes(actual.evidence_basis);
}

// A review can be reconciled only for the exact record, decision and human.
// An old/different reviewer, reason or checklist is never a valid ACK.
// This does not make the POST idempotent, and cannot certify field execution.
export function reconcileReviewReceipt(response, {
  orderId, reportId, reviewerId, decision, reason, checklist
}) {
  if (!orderId || !reportId || !reviewerId ||
      !['verified', 'rejected'].includes(decision)) {
    throw new Error('Faltan datos para comprobar la revisión.');
  }
  const order = validateWorkOrderDetail(response, orderId);
  const reports = order.WorkOrderExecutions;
  if (!Array.isArray(reports) || reports.some(report =>
    !report || typeof report.id !== 'string' || !report.id ||
    report.work_order_id !== orderId)) {
    throw new Error('El servidor no devolvió un historial de partes válido.');
  }
  const matches = reports.filter(report => report.id === reportId);
  if (matches.length > 1) throw new Error('El historial de revisiones es ambiguo.');
  if (matches.length === 0 || matches[0].review_status === 'submitted') {
    return { state: 'unconfirmed', order };
  }
  const report = matches[0];
  const payloadMatches = decision === 'verified'
    ? sameChecklist(report.review_checklist, checklist)
    : typeof reason === 'string' && reason.trim().length >= 10 &&
      report.review_note === reason.trim();
  if (report.review_status === decision && report.reviewed_by === reviewerId &&
      report.reviewed_at && Number.isFinite(Date.parse(report.reviewed_at)) &&
      payloadMatches) {
    return { state: 'recorded', order, reportId };
  }
  return { state: 'different', order };
}
