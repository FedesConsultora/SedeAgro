import { sessionScope } from './offlineSyncModel.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const SERVER_STATES = new Set(['received', 'processing', 'processed', 'failed']);

const validId = value => typeof value === 'string' && UUID.test(value);

// Only read current-user receipts. Never trust the broader administrator
// /sync/batches listing to reconcile somebody else's encrypted local draft.
export function parseMySyncReceipts(response, session) {
  if (!sessionScope(session) || !Array.isArray(response?.data) || response.data.length > 100) {
    throw new Error('El servidor no devolvió recibos verificables de esta cuenta.');
  }
  const rows = response.data;
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) ||
    !validId(row.id) || row.submitted_by !== session.user.id ||
    !SERVER_STATES.has(row.status) ||
    (row.idempotency_key != null && !validId(row.idempotency_key)) ||
    !Array.isArray(row.SyncOperations))) {
    throw new Error('Los recibos incluyen datos inválidos o de otro usuario.');
  }
  return rows;
}

function draftMatchesActor(draft, session) {
  const scope = sessionScope(session);
  return Boolean(scope && draft?.scope === scope &&
    typeof draft?.id === 'string' && draft.id.startsWith(`${scope}:`) &&
    draft.body?.idempotency_key === draft.idempotencyKey &&
    validId(draft.idempotencyKey) &&
    draft.body?.client_id &&
    Array.isArray(draft.body?.operations) && draft.body.operations.length === 1 &&
    draft.body.operations[0]?.payload?.scouting_run_id === draft.runId);
}

export function reconcileOfflineDraft(draft, receipts, session) {
  if (!draftMatchesActor(draft, session) || !Array.isArray(receipts)) {
    return { status: 'unverified', observationId: null };
  }
  const matched = receipts.filter(row =>
    row?.submitted_by === session.user.id && row?.idempotency_key === draft.idempotencyKey);
  if (!matched.length) return { status: 'not_listed', observationId: null };
  if (matched.length !== 1) return { status: 'ambiguous', observationId: null };
  const receipt = matched[0];
  if (receipt.client_id !== draft.body.client_id || !validId(receipt.id)) {
    return { status: 'ambiguous', observationId: null };
  }
  if (receipt.status !== 'processed') {
    return { status: 'not_applied', observationId: null };
  }
  const expected = draft.body.operations[0];
  const operations = receipt.SyncOperations;
  if (!Array.isArray(operations) || operations.length !== 1) {
    return { status: 'ambiguous', observationId: null };
  }
  const operation = operations[0];
  if (operation?.entity_type !== expected.entity_type ||
    operation?.operation !== expected.operation ||
    operation?.entity_client_id !== expected.entity_client_id ||
    operation?.status !== 'applied' ||
    !validId(operation?.result?.observation_id) ||
    operation?.result?.scouting_run_id !== draft.runId ||
    (draft.syncedObservationId && operation.result.observation_id !== draft.syncedObservationId)) {
    return { status: 'ambiguous', observationId: null };
  }
  return {
    status: draft.evidence ? 'photo_pending' : 'confirmed',
    observationId: operation.result.observation_id,
    batchId: receipt.id
  };
}

export const RECONCILIATION_STATUS = Object.freeze({
  confirmed: {
    heading: 'Observación aplicada en PostgreSQL',
    detail: 'El recibo coincide con esta cuenta, recorrida, clave de envío y operación. Podés liberar la copia local.'
  },
  photo_pending: {
    heading: 'Observación aplicada · foto sin confirmar',
    detail: 'El recibo confirma la observación, pero no el archivo. Conservá el borrador cifrado y reintentá la foto.'
  },
  not_listed: {
    heading: 'Sin recibo en los últimos 100 envíos',
    detail: 'La ausencia en este listado limitado NO prueba que el servidor no haya aplicado el envío. Reintentá con la misma clave.'
  },
  not_applied: {
    heading: 'Lote visto, aún no aplicado',
    detail: 'El servidor devolvió un estado sin aplicación definitiva; el borrador local se conserva.'
  },
  ambiguous: {
    heading: 'Recibo inconsistente',
    detail: 'No coincide el identificador de operación o los datos necesarios. Se conserva el borrador para evitar pérdidas.'
  },
  unverified: {
    heading: 'Sin verificación segura',
    detail: 'No se pudo comprobar el alcance o la integridad de esta operación. No se modifica el borrador.'
  }
});
