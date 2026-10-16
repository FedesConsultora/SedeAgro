import { QUANTITY_PATTERN } from './inputDeclaration.js';

export const MAX_UNPLANNED_INPUTS = 8;

export function exceptionsForReport(items, reportId) {
  return Array.isArray(items) ? items.filter(item => item.work_order_execution_id === reportId) : [];
}

export function canProposeException(order, report, userId, live, count = 0) {
  return Boolean(live && userId && order?.status === 'in_progress' &&
    report?.review_status === 'submitted' && report.submitted_by === userId &&
    Number.isInteger(count) && count >= 0 && count < MAX_UNPLANNED_INPUTS);
}

export function canReviewExceptionUI(order, report, exception, role, userId, live) {
  return Boolean(live && order?.status === 'in_progress' && report?.review_status === 'submitted' &&
    exception?.review_status === 'submitted' && userId && exception.submitted_by !== userId &&
    ['tenant_admin', 'agronomic_coordinator'].includes(role));
}

export function canVerifyWithExceptions(items) {
  return Array.isArray(items) && items.every(item => item.review_status === 'approved');
}

export function makeExceptionPayload(catalog, inputId, value, reason, requestId) {
  if (!catalog.some(item => item.id === inputId)) throw new Error('Elegí un insumo del catálogo.');
  if (typeof value !== 'string' || !QUANTITY_PATTERN.test(value) || !/[1-9]/.test(value)) {
    throw new Error('Ingresá una cantidad positiva con hasta cuatro decimales.');
  }
  if (reason.trim().length < 10 || reason.trim().length > 500) {
    throw new Error('Explicá la situación con entre 10 y 500 caracteres.');
  }
  return { client_request_id: requestId, input_id: inputId,
    declared_quantity: value, reason: reason.trim() };
}

export function confirmException(response, reportId, inputId = null) {
  const item = response?.data;
  if (!item || typeof item.id !== 'string' ||
      item.work_order_execution_id !== reportId ||
      (inputId && item.input_id !== inputId) ||
      !['submitted', 'approved', 'rejected'].includes(item.review_status)) {
    throw new Error('El servidor no confirmó la excepción.');
  }
  return item;
}
