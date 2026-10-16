import { HttpError } from '../../utils/http.js';
import { quantityUnits, unitsString } from './inputDeclarationPolicy.js';

export const MAX_UNPLANNED_INPUTS = 8;

export function positiveDeclaredQuantity(value) {
  const units = quantityUnits(value);
  if (units <= 0) throw new HttpError(422,
    'Un insumo no previsto requiere una cantidad positiva.', undefined, 'EXCEPTION_QUANTITY_REQUIRED');
  return unitsString(units);
}

export function sameUnplannedRequest(existing, body, { orderId, executionId, actorId }) {
  let quantity;
  try { quantity = positiveDeclaredQuantity(body.declared_quantity); }
  catch { return false; }
  return Boolean(existing &&
    existing.client_request_id === body.client_request_id &&
    existing.work_order_id === orderId &&
    existing.work_order_execution_id === executionId &&
    existing.submitted_by === actorId &&
    existing.input_id === body.input_id &&
    unitsString(quantityUnits(String(existing.quantity))) === quantity &&
    existing.reason === body.reason.trim());
}

export function canApproveWithExceptions(exceptions) {
  return Array.isArray(exceptions) && exceptions.length <= MAX_UNPLANNED_INPUTS &&
    exceptions.every(item => item.review_status === 'approved');
}

export function canReviewException(roleCode, reviewerId, submitterId) {
  return Boolean(reviewerId && submitterId && reviewerId !== submitterId &&
    (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator'));
}

export function publicException(record) {
  return {
    id: record.id,
    work_order_execution_id: record.work_order_execution_id,
    input_id: record.input_id,
    input_name: record.input_name,
    unit: record.unit,
    quantity: String(record.quantity),
    reason: record.reason,
    submitted_by: record.submitted_by,
    review_status: record.review_status,
    reviewed_by: record.reviewed_by,
    reviewed_at: record.reviewed_at,
    review_note: record.review_note,
    created_at: record.created_at
  };
}
