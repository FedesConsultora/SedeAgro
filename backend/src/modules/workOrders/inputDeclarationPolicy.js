import { HttpError } from '../../utils/http.js';

export const MAX_DECLARED_INPUTS = 25;
const DECIMAL_QUANTITY = /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,4})?$/;

export function quantityUnits(text) {
  if (typeof text !== 'string' || !DECIMAL_QUANTITY.test(text)) {
    throw new HttpError(422, 'Cantidad inválida: informá hasta 8 enteros y 4 decimales, sin exponentes.',
      undefined, 'EXECUTION_INPUT_QUANTITY_INVALID');
  }
  const [integer, fractional = ''] = text.split('.');
  const units = Number(integer) * 10000 + Number(fractional.padEnd(4, '0'));
  if (!Number.isSafeInteger(units)) throw new HttpError(422, 'Cantidad fuera de rango.');
  return units;
}

export function unitsString(units) {
  if (!Number.isSafeInteger(units)) throw new Error('Quantity precision exceeded');
  const sign = units < 0 ? '-' : '';
  const abs = Math.abs(units);
  const int = Math.floor(abs / 10000);
  const frac = String(abs % 10000).padStart(4, '0').replace(/0+$/, '');
  return sign + int + (frac ? `.${frac}` : '');
}

export function buildInputDeclaration({ rows, payload, userId, timestamp = new Date() }) {
  if (!Array.isArray(rows) || rows.length > MAX_DECLARED_INPUTS) {
    throw new HttpError(409, 'La orden supera el límite de 25 insumos planificados.',
      undefined, 'EXECUTION_INPUT_PLAN_LIMIT');
  }
  const requested = new Map();
  for (const item of payload.items) {
    if (requested.has(item.work_order_input_id)) {
      throw new HttpError(422, 'Un insumo está repetido en la declaración.',
        undefined, 'EXECUTION_INPUT_DUPLICATE');
    }
    requested.set(item.work_order_input_id, item);
  }
  if (requested.size !== rows.length) {
    throw new HttpError(422, 'Declarar exactamente todos los insumos del plan.',
      undefined, 'EXECUTION_INPUT_PLAN_MISMATCH');
  }
  let hasDifference = false;
  const items = rows.map(row => {
    const selected = requested.get(row.id);
    if (!selected || !row.AgriculturalInput || row.AgriculturalInput.id !== row.input_id) {
      throw new HttpError(422, 'Un insumo no corresponde al plan vigente de la orden.',
        undefined, 'EXECUTION_INPUT_PLAN_MISMATCH');
    }
    const actualUnits = quantityUnits(selected.declared_quantity);
    const plannedUnits = row.total_quantity == null ? null : quantityUnits(String(row.total_quantity));
    const variance = plannedUnits === null ? null : unitsString(actualUnits - plannedUnits);
    if (plannedUnits !== null && actualUnits !== plannedUnits) hasDifference = true;
    return {
      work_order_input_id: row.id,
      input_id: row.input_id,
      name: row.AgriculturalInput.name,
      unit: row.AgriculturalInput.unit,
      planned_quantity: plannedUnits == null ? null : unitsString(plannedUnits),
      declared_quantity: unitsString(actualUnits),
      variance_quantity: variance
    };
  }).sort((a, b) => a.work_order_input_id.localeCompare(b.work_order_input_id));
  const notes = payload.notes.trim();
  if (hasDifference && notes.length < 10) {
    throw new HttpError(422, 'Explicá la diferencia entre lo planificado y lo informado (mínimo 10 caracteres).',
      undefined, 'EXECUTION_INPUT_VARIANCE_NOTE_REQUIRED');
  }
  return {
    client_declaration_id: payload.client_declaration_id,
    declared_by: userId,
    declared_at: timestamp.toISOString(),
    notes, items
  };
}

// Replay compares only client-controlled information, never timestamps or
// server-derived quantities supplied by an untrusted browser.
export function sameInputDeclaration(existing, payload) {
  if (!existing || existing.client_declaration_id !== payload.client_declaration_id ||
      existing.notes !== payload.notes.trim() ||
      !Array.isArray(existing.items) || existing.items.length !== payload.items.length) return false;
  let requested;
  try {
    requested = new Map(payload.items.map(item =>
      [item.work_order_input_id, unitsString(quantityUnits(item.declared_quantity))]));
  } catch { return false; }
  return requested.size === existing.items.length && existing.items.every(row =>
    requested.get(row.work_order_input_id) === row.declared_quantity);
}

export function hasRequiredInputDeclaration(plannedCount, report) {
  return plannedCount === 0 || Boolean(report?.input_declaration &&
    Array.isArray(report.input_declaration.items) &&
    report.input_declaration.items.length === plannedCount);
}
