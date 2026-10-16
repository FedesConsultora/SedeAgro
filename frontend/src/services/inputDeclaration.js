// Presentation only. Server always re-reads planned inputs and checks
// the authenticated author's immutable snapshot against the approved order.
export const MAX_INPUT_LINES = 25;
export const QUANTITY_PATTERN = /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,4})?$/;

export function plannedInputs(order) {
  return Array.isArray(order?.WorkOrderInputs) ? order.WorkOrderInputs : [];
}

export function canReportInputs(order, report, userId, live) {
  return Boolean(live && report?.review_status === 'submitted' &&
    !report.input_declaration && order?.status === 'in_progress' &&
    userId && report.submitted_by === userId &&
    plannedInputs(order).length > 0 && plannedInputs(order).length <= MAX_INPUT_LINES);
}

export function validateInputDeclarationPayload(lines, quantities, notes, clientId) {
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_INPUT_LINES) {
    throw new Error('El plan no contiene insumos declarables en este formulario.');
  }
  const items = lines.map(line => {
    const value = quantities[line.id]?.trim();
    if (!QUANTITY_PATTERN.test(value || '')) {
      throw new Error('Completá cada cantidad en la unidad informada, con hasta cuatro decimales.');
    }
    return { work_order_input_id: line.id, declared_quantity: value };
  });
  const reason = notes.trim();
  if (reason.length > 500) throw new Error('La explicación supera 500 caracteres.');
  // Differences and their necessity are ultimately checked using server-side
  // NUMERIC snapshots, not by trusting JS floating point from the browser.
  return { client_declaration_id: clientId, notes: reason, items };
}

export function validateInputDeclarationResponse(response, orderId, reportId, clientId) {
  const report = response?.data;
  if (!report || report.id !== reportId || report.work_order_id !== orderId ||
      report.input_declaration?.client_declaration_id !== clientId) {
    throw new Error('El servidor no confirmó la declaración de insumos.');
  }
  return report;
}

export function hasPlannedInputsWithoutDeclaration(order, report) {
  return plannedInputs(order).length > 0 && !report?.input_declaration;
}
