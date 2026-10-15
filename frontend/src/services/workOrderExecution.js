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
export function validatedExecutionResponse(response, orderId, reviewStatus, reportId = null) {
  const report = response?.data;
  if (!report || report.work_order_id !== orderId || report.review_status !== reviewStatus ||
      typeof report.id !== 'string' || (reportId && report.id !== reportId)) {
    throw new Error('El servidor no confirmó la operación de ejecución. Actualizá la orden.');
  }
  return report;
}
