// 0T.14: an advisory presentation gate, never a substitute for the
// transactional role, tenant, SHA and exception checks in workOrders/router.js.
// Fail closed while server-side exception history is unavailable or stale.
export function reportSignature(reports) {
  return Array.isArray(reports) && reports.every(report => typeof report?.id === 'string')
    ? reports.map(report => report.id).join('|') : null;
}

export function exceptionReadinessForReview(order, report, snapshot) {
  const allReports = order?.WorkOrderExecutions;
  const signature = reportSignature(allReports);
  if (!order || !report || !signature ||
      !allReports.some(item => item.id === report.id)) {
    return { allowed: false, reason: 'El parte no está confirmado en el detalle de la orden.' };
  }
  if (snapshot?.orderId !== order.id || snapshot?.reportSignature !== signature ||
      snapshot.phase !== 'ready' || !Array.isArray(snapshot.items)) {
    return { allowed: false, reason: snapshot?.phase === 'error' &&
      snapshot.orderId === order.id && snapshot.reportSignature === signature
      ? 'No se pudieron consultar los insumos no previstos. Reintentá la consulta.'
      : 'Consultando el estado de los insumos no previstos antes de la aprobación.' };
  }
  if (!snapshot.items.every(item =>
    typeof item?.id === 'string' && typeof item.work_order_execution_id === 'string' &&
    allReports.some(record => record.id === item.work_order_execution_id) &&
    ['submitted', 'approved', 'rejected'].includes(item.review_status))) {
    return { allowed: false, reason: 'La respuesta de excepciones es inválida; actualizá el detalle.' };
  }
  const exceptions = snapshot.items.filter(item => item.work_order_execution_id === report.id);
  if (exceptions.some(item => item.review_status === 'rejected')) {
    return { allowed: false, reason: 'Hay una excepción rechazada. Rechazá el parte para recibir una nueva declaración.' };
  }
  if (exceptions.some(item => item.review_status !== 'approved')) {
    return { allowed: false, reason: 'Coordinación debe resolver las excepciones pendientes antes de aceptar el parte.' };
  }
  return { allowed: true, reason: '' };
}
