import { parseMySyncReceipts } from './offlineReconciliation.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const validUuid = value => typeof value === 'string' && UUID.test(value);
const dateValue = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;

export const RUN_SYNC_HISTORY_PAGE_SIZE = 10;

// A personal sync batch is not an evidence receipt and is not the global
// history of the run. Only operations with a server-returned result.run_id
// may be attributed to the requested run; never infer from client_id, key,
// device, payload, or some other actor's receipts.
export function buildRunPersonalSyncHistory(response, session, runId) {
  if (!validUuid(runId)) {
    throw new Error('La recorrida no tiene una identidad verificable.');
  }
  const receipts = parseMySyncReceipts(response, session);
  const seenBatches = new Set();
  const seenOperations = new Set();
  const candidates = [];

  for (const batch of receipts) {
    if (seenBatches.has(batch.id)) {
      throw new Error('El servidor devolvió recibos personales duplicados.');
    }
    seenBatches.add(batch.id);
    for (const [index, operation] of batch.SyncOperations.entries()) {
      if (operation?.result?.scouting_run_id !== runId) continue;
      // A missing or malformed operation proves neither application nor
      // failure. Retain one visibly ambiguous history row, never a success.
      const validOperation = operation && validUuid(operation.id) &&
        validUuid(operation.entity_client_id) &&
        operation.entity_type === 'scouting_observation' &&
        operation.operation === 'create' &&
        operation.status === 'applied' &&
        validUuid(operation.result?.observation_id);
      const identity = validUuid(operation?.id) ? operation.id : `${batch.id}:${index}`;
      const repeated = seenOperations.has(identity);
      seenOperations.add(identity);
      const confirmed = !repeated && validOperation && batch.status === 'processed';
      candidates.push({
        key: `${batch.id}:${index}`,
        batchId: batch.id,
        operationId: validUuid(operation?.id) ? operation.id : null,
        observationId: confirmed ? operation.result.observation_id : null,
        observedIdentity: validOperation ? operation.result.observation_id : null,
        status: confirmed ? 'confirmed' : 'unverified',
        receivedAt: dateValue(batch.received_at),
        processedAt: dateValue(batch.processed_at),
        timestamp: dateValue(batch.processed_at) || dateValue(batch.received_at),
        isReplay: false
      });
    }
  }

  // A duplicate observation result (different batch / operation IDs) must
  // not inflate the success count even if each row otherwise says "applied".
  const observationCounts = new Map();
  for (const item of candidates) {
    if (item.observedIdentity) {
      observationCounts.set(item.observedIdentity, (observationCounts.get(item.observedIdentity) || 0) + 1);
    }
  }
  for (const item of candidates) {
    if (item.observedIdentity && observationCounts.get(item.observedIdentity) !== 1) {
      item.status = 'unverified';
      item.observationId = null;
    }
    delete item.observedIdentity;
  }

  candidates.sort((a, b) =>
    (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0) ||
    a.key.localeCompare(b.key));

  return {
    entries: candidates,
    confirmed: candidates.filter(row => row.status === 'confirmed').length,
    unverified: candidates.filter(row => row.status === 'unverified').length,
    receiptWindow: receipts.length,
    atLimit: receipts.length === 100
  };
}
