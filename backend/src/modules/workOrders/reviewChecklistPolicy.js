// A human review of self-declared work is NOT physical certification.
// More safety-sensitive types require an attached, hash-intact file before
// administrative acceptance. No GPS, sensor or provenance is inferred.
export const EVIDENCE_REQUIRED_ORDER_TYPES = Object.freeze(['application', 'fertilization']);

export function executionReviewRequirement(type) {
  return {
    type,
    evidence_required: EVIDENCE_REQUIRED_ORDER_TYPES.includes(type),
    operation_hint: ({
      application: 'Contrasté la operación y los insumos declarados con la orden.',
      fertilization: 'Contrasté el tratamiento y los insumos declarados con la orden.',
      sowing: 'Contrasté la siembra declarada con el objetivo de la orden.',
      harvest: 'Contrasté los resultados declarados de la cosecha.',
      irrigation: 'Contrasté el riego declarado con lo solicitado.',
      inspection: 'Contrasté el resultado de inspección declarado.',
      other: 'Contrasté la actividad declarada con lo solicitado.'
    })[type] || 'Contrasté la actividad declarada con lo solicitado.'
  };
}

export function canAcceptReviewChecklist(type, checklist, attachmentCount) {
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist) ||
      checklist.time_checked !== true || checklist.area_checked !== true ||
      checklist.result_checked !== true || checklist.operation_checked !== true ||
      !Number.isInteger(attachmentCount) || attachmentCount < 0) return false;
  const required = executionReviewRequirement(type).evidence_required;
  if (required && attachmentCount === 0) return false;
  return checklist.evidence_basis === (attachmentCount > 0 ? 'reviewed_files' : 'no_files');
}
