// Pure presentation helpers; backend independently validates every check.
export const ORDER_TYPES_WITH_REQUIRED_EVIDENCE = Object.freeze(['application', 'fertilization']);

export function operationReviewLabel(type) {
  const labels = {
    application: 'Contrasté el tratamiento y los insumos con la orden.',
    fertilization: 'Contrasté la fertilización y los insumos con la orden.',
    sowing: 'Contrasté la siembra declarada con el objetivo.',
    harvest: 'Contrasté el resultado de cosecha informado.',
    irrigation: 'Contrasté el riego informado.',
    inspection: 'Contrasté los resultados de inspección informados.',
    other: 'Contrasté la actividad informada con lo solicitado.'
  };
  return labels[type] || labels.other;
}

export function buildVerifiedReviewChecklist(draft, type) {
  const checks = ['time_checked', 'area_checked', 'result_checked', 'operation_checked'];
  if (!checks.every(key => draft?.[key] === true)) {
    throw new Error('Marcá los cuatro controles antes de aceptar el parte.');
  }
  const basis = draft.evidence_basis;
  if (!['reviewed_files', 'no_files'].includes(basis)) {
    throw new Error('Indicá si examinaste archivos adjuntos o si el parte no tiene respaldo.');
  }
  if (ORDER_TYPES_WITH_REQUIRED_EVIDENCE.includes(type) && basis === 'no_files') {
    throw new Error('Las aplicaciones y fertilizaciones requieren un adjunto privado íntegro.');
  }
  return { time_checked: true, area_checked: true, result_checked: true,
    operation_checked: true, evidence_basis: basis };
}

export function reviewChecklistOutcome(record) {
  const checklist = record?.review_checklist;
  if (!checklist || record.review_status !== 'verified') return null;
  try { return buildVerifiedReviewChecklist(checklist, null); }
  catch { return null; }
}
