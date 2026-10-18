// 0T.15 — Operational *hints*, NOT authorizations or proof of execution.
// The final review endpoint independently locks and verifies every requirement.
export const REVIEW_QUEUE_PAGE_SIZE = 50;
export const REVIEW_QUEUE_STATES = Object.freeze([
  'awaiting_report', 'self_authored', 'awaiting_inputs', 'rejected_exception',
  'pending_exception', 'awaiting_evidence', 'human_review', 'ready_for_closure'
]);

export function classifyReviewQueueItem({ order, report, plannedInputCount,
  exceptions, evidenceCount, reviewerId }) {
  if (!order || order.status !== 'in_progress' || !reviewerId ||
    !Number.isInteger(plannedInputCount) || plannedInputCount < 0 ||
    !Array.isArray(exceptions) || !Number.isInteger(evidenceCount) || evidenceCount < 0) {
    throw new Error('Incomplete order review queue data');
  }
  const base = { id: order.id, title: order.title, type: order.type,
    priority: order.priority, due_at: order.due_at, status: order.status,
    report_id: report?.id ?? null, reason: null, state: null };
  const value = (state, reason) => ({ ...base, state, reason });
  if (!report) return value('awaiting_report', 'El responsable todavía no presentó un parte.');
  if (report.review_status === 'verified') {
    return value('ready_for_closure', 'Existe un parte verificado; coordinación puede evaluar el cierre.');
  }
  if (report.review_status !== 'submitted') throw new Error('Unexpected report review state');
  if (report.submitted_by === reviewerId) {
    return value('self_authored', 'Este parte es propio; la revisión requiere otra persona autorizada.');
  }
  if (plannedInputCount > 0 &&
    (!Array.isArray(report.input_declaration?.items) ||
      report.input_declaration.items.length !== plannedInputCount)) {
    return value('awaiting_inputs', 'Falta declarar todos los insumos planificados.');
  }
  if (exceptions.some(item => item.review_status === 'rejected')) {
    return value('rejected_exception', 'Una excepción fue rechazada; corresponde rechazar y rehacer el parte.');
  }
  if (exceptions.some(item => item.review_status !== 'approved')) {
    return value('pending_exception', 'Hay insumos no previstos pendientes de resolución.');
  }
  if (['application', 'fertilization'].includes(order.type) && evidenceCount === 0) {
    return value('awaiting_evidence', 'Esta operación requiere al menos un respaldo privado.');
  }
  return value('human_review',
    'Candidato a revisión humana: falta checklist y comprobar integridad de archivos al aprobar.');
}
