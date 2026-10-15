import { sessionScope, MAX_PENDING_BATCHES } from './offlineSyncModel.js';
import { validateOfflinePhoto } from './offlinePhoto.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const validUuid = value => typeof value === 'string' && UUID.test(value);
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const STATES = new Set(['pending', 'conflict', 'auth']);

export function parseRunEvidenceStatus(response, runId, { expectedLimit = null, paginated = false } = {}) {
  const data = response?.data;
  if (!validUuid(runId) || data?.run_id !== runId ||
      !Number.isInteger(data?.limit) || data.limit < 1 || data.limit > 100 ||
      (expectedLimit !== null && data.limit !== expectedLimit) ||
      typeof data.has_more !== 'boolean' || !Array.isArray(data.items) ||
      data.items.length > data.limit ||
      (paginated && (!Object.hasOwn(data, 'next_cursor') ||
        (data.next_cursor !== null && (typeof data.next_cursor !== 'string' ||
          data.next_cursor.length > 640 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(data.next_cursor))) ||
        Boolean(data.next_cursor) !== data.has_more))) {
    throw new Error('El servidor no devolvió un estado verificable de evidencias de esta recorrida.');
  }
  const ids = new Set();
  const items = data.items.map(item => {
    if (!item || !validUuid(item.id) || !validUuid(item.scouting_observation_id) ||
        !validUuid(item.uploaded_by) ||
        (item.client_upload_id !== null && !validUuid(item.client_upload_id)) ||
        !['photo', 'document'].includes(item.kind) || !MIMES.has(item.mime_type) ||
        !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 1 ||
        (item.captured_at != null && !Number.isFinite(Date.parse(item.captured_at))) ||
        typeof item.bytes_available !== 'boolean' || ids.has(item.id) ||
        (item.kind === 'photo' && item.mime_type === 'application/pdf') ||
        (item.kind === 'document' && item.mime_type !== 'application/pdf')) {
      throw new Error('El servidor devolvió metadatos de evidencia inválidos o duplicados.');
    }
    ids.add(item.id);
    return {
      id: item.id,
      observationId: item.scouting_observation_id,
      uploadedBy: item.uploaded_by,
      clientUploadId: item.client_upload_id,
      kind: item.kind,
      mimeType: item.mime_type,
      sizeBytes: item.size_bytes,
      capturedAt: item.captured_at || null,
      bytesAvailable: item.bytes_available
    };
  });
  return {
    items, hasMore: data.has_more, nextCursor: data.next_cursor ?? null,
    photosWithBytes: items.filter(item => item.kind === 'photo' && item.bytesAvailable).length,
    missingBytes: items.filter(item => !item.bytesAvailable).length
  };
}

// A server asset with the original upload UUID and actor is independent
// evidence of storage. It does NOT authorize local cleanup, nor verify a SHA.
// A missing row may simply have fallen outside the last-100 window.
export function buildRunEvidenceProvenance(response, localRows, session, runId, options = {}) {
  const scope = sessionScope(session);
  if (!scope || !validUuid(runId) || !Array.isArray(localRows) ||
      localRows.length > MAX_PENDING_BATCHES) {
    throw new Error('No hay una cuenta o cola de campo verificable.');
  }
  const server = parseRunEvidenceStatus(response, runId, options);
  const localIds = new Set();
  const matchedServer = new Set();
  const local = [];
  for (const row of localRows) {
    if (!row || row.scope !== scope || typeof row.id !== 'string' ||
        row.id !== `${scope}:${row.idempotencyKey}` ||
        row.body?.idempotency_key !== row.idempotencyKey ||
        !validUuid(row.idempotencyKey) || !STATES.has(row.state)) {
      throw new Error('La cola local no coincide con la cuenta activa.');
    }
    if (row.runId !== runId || !row.evidence) continue;
    if (localIds.has(row.id)) throw new Error('La cola tiene fotografías duplicadas.');
    localIds.add(row.id);
    if (!Array.isArray(row.body?.operations) || row.body.operations.length !== 1 ||
        row.body.operations[0]?.entity_type !== 'scouting_observation' ||
        row.body.operations[0]?.operation !== 'create' ||
        row.body.operations[0]?.payload?.scouting_run_id !== runId) {
      throw new Error('La fotografía local no corresponde a una observación válida.');
    }
    const photo = validateOfflinePhoto(row.evidence);
    if (photo.kind !== 'photo' || !validUuid(photo.client_upload_id) ||
        (row.syncedObservationId && !validUuid(row.syncedObservationId))) {
      throw new Error('La fotografía no tiene identidad estable verificable.');
    }
    const candidates = server.items.filter(item =>
      item.clientUploadId === photo.client_upload_id &&
      item.uploadedBy === session.user.id);
    const compatible = candidates.length === 1 &&
      candidates[0].kind === 'photo' &&
      candidates[0].mimeType === photo.mime_type &&
      candidates[0].sizeBytes === photo.size_bytes &&
      (!row.syncedObservationId || candidates[0].observationId === row.syncedObservationId);
    const asset = compatible ? candidates[0] : null;
    if (asset && matchedServer.has(asset.id)) {
      throw new Error('Una evidencia no puede representar dos fotografías locales.');
    }
    if (asset) matchedServer.add(asset.id);
    local.push({
      id: row.id, createdAt: row.createdAt || null,
      status: candidates.length && !compatible ? 'mismatch' :
        asset ? (asset.bytesAvailable ? 'present' : 'metadata_only') :
          (options.paginated || server.hasMore) ? 'outside_window' : 'not_listed',
      evidenceId: asset?.id || null
    });
  }
  local.sort((a,b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) ||
    a.id.localeCompare(b.id));
  return { ...server, localPhotos: local };
}
