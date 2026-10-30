// Presentation constraints, never a substitute for orders.execute/orders.write and RLS.
export function executionReports(order) {
  return Array.isArray(order?.WorkOrderExecutions) ? order.WorkOrderExecutions : [];
}
export function canDeclareExecution(order, roleCode, userId, live) {
  return Boolean(live && order?.status === 'in_progress' && userId &&
    !executionReports(order).some(r => ['submitted', 'verified'].includes(r.review_status)) &&
    (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator' ||
      (roleCode === 'contractor' && order.WorkOrderAssignees?.some(r => r.user_id === userId))));
}
export function canReviewExecutionReport(order, report, roleCode, userId, live) {
  return Boolean(live && order?.status === 'in_progress' && report?.review_status === 'submitted' &&
    userId && report.submitted_by !== userId &&
    (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator'));
}
export function toExecutionTimestamp(localInput) {
  const date = new Date(localInput);
  if (!localInput || !Number.isFinite(date.getTime())) throw new Error('Informá una fecha y hora válidas.');
  return date.toISOString();
}
// Operator-side preflight only: backend validExecutionWindow, Zod, assignment and
// tenant RLS remain authoritative. Never report success without server receipt.
// Browser datetime-local is converted to an offset-aware UTC instant exactly once.
export function buildExecutionDraft({ started, finished, area, outcome, approvedAt }, now = new Date()) {
  const startedAt = toExecutionTimestamp(started);
  const finishedAt = toExecutionTimestamp(finished);
  const approval = approvedAt ? new Date(approvedAt) : null;
  if (!approval || !Number.isFinite(approval.getTime())) {
    throw new Error('La orden no tiene una fecha de aprobación válida. Actualizá el detalle antes de declarar.');
  }
  const startMs = Date.parse(startedAt);
  const finishMs = Date.parse(finishedAt);
  if (startMs < approval.getTime()) {
    throw new Error('El inicio informado no puede ser anterior a la aprobación de la orden.');
  }
  if (finishMs < startMs) {
    throw new Error('La finalización informada no puede ser anterior al inicio.');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('No se pudo validar la hora del dispositivo.');
  }
  if (finishMs > now.getTime() + 5 * 60 * 1000) {
    throw new Error('La finalización informada no puede estar en el futuro.');
  }
  const workedArea = Number(area);
  if (typeof area === 'boolean' || String(area ?? '').trim() === '' ||
      !Number.isFinite(workedArea) || workedArea < 0.01 || workedArea > 1000000 ||
      Math.abs(workedArea * 100 - Math.round(workedArea * 100)) >= 1e-6) {
    throw new Error('Informá una superficie entre 0,01 y 1.000.000 ha, con hasta dos decimales.');
  }
  const summary = typeof outcome === 'string' ? outcome.trim() : '';
  if (summary.length < 10 || summary.length > 2000) {
    throw new Error('Describí el resultado en 10 a 2.000 caracteres.');
  }
  return {
    started_at: startedAt, finished_at: finishedAt,
    worked_area_hectares: workedArea, result_summary: summary
  };
}

export function validatedExecutionResponse(response, orderId, reviewStatus, reportId = null) {
  const report = response?.data;
  if (!report || report.work_order_id !== orderId || report.review_status !== reviewStatus ||
      typeof report.id !== 'string' || (reportId && report.id !== reportId)) {
    throw new Error('El servidor no confirmó la operación de ejecución. Actualizá la orden.');
  }
  return report;
}
