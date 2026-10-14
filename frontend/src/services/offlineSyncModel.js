// Pure, browser-independent offline queue contract. No auth tokens or tenant-wide
// data are copied into queued records; the caller must supply a live session scope.
import { validateOfflinePhoto } from './offlinePhoto.js';

export const QUEUE_CLIENT_ID = 'sedeagro-web-offline-v1';
export const MAX_PENDING_BATCHES = 100;
export const QUEUE_EVENT = 'sedeagro:offline-queue-updated';
const observationTypes = new Set(['weed', 'pest', 'disease', 'phenology', 'nutrition', 'water', 'general']);
const severities = new Set(['low', 'medium', 'high', 'critical']);

export function sessionScope(session) {
  const userId = session?.user?.id;
  const tenantId = session?.tenant?.id;
  if (!userId || !tenantId || !session?.token) return null;
  return `${tenantId}:${userId}`;
}

export function createPendingObservation({ session, runId, values, uuid, now = new Date() }) {
  const scope = sessionScope(session);
  if (!scope) throw new Error('Iniciá sesión en la empresa correspondiente antes de guardar.');
  if (!/^[a-f0-9-]{36}$/i.test(String(runId))) throw new Error('La recorrida no tiene un ID válido.');
  if (!observationTypes.has(values?.observation_type) || !severities.has(values?.severity)) {
    throw new Error('Tipo o severidad de observación inválidos.');
  }
  const notes = String(values?.notes ?? '').trim();
  if (notes.length < 1 || notes.length > 10000) throw new Error('La descripción debe tener entre 1 y 10000 caracteres.');
  const observedAt = values?.observed_at ? new Date(values.observed_at) : now;
  if (!Number.isFinite(observedAt.getTime())) throw new Error('Fecha de observación inválida.');
  const id = uuid();
  const opId = uuid();
  const body = {
    client_id: QUEUE_CLIENT_ID,
    idempotency_key: id,
    operations: [{
      entity_type: 'scouting_observation',
      entity_client_id: opId,
      operation: 'create',
      payload: {
        scouting_run_id: runId,
        observation_type: values.observation_type,
        severity: values.severity,
        notes,
        observed_at: observedAt.toISOString()
      }
    }]
  };
  const photo = values?.photo ? validateOfflinePhoto(values.photo) : null;
  const evidence = photo ? {
    client_upload_id: uuid(),
    kind: 'photo',
    original_name: photo.original_name,
    mime_type: photo.mime_type,
    content_base64: photo.content_base64
  } : null;
  return {
    id: `${scope}:${id}`, scope, runId,
    idempotencyKey: id,
    ...(evidence ? { evidence } : {}),
    body,
    state: 'pending',
    createdAt: now.toISOString(),
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    errorCode: null
  };
}

export function classifySyncError(error) {
  const status = Number(error?.status || 0);
  if (status === 401) return 'auth';
  if ([400, 403, 404, 409, 422].includes(status)) return 'conflict';
  return 'retry';
}

export function isEligibleForAutoRetry(item, now = Date.now()) {
  return item?.state === 'pending' &&
    (!item.nextRetryAt || Date.parse(item.nextRetryAt) <= now);
}

export function retryDelayMs(attempts) {
  return Math.min(300000, 5000 * (2 ** Math.min(Math.max(0, attempts - 1), 6)));
}
