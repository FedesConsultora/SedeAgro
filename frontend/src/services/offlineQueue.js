import {
  classifySyncError, createPendingObservation, isEligibleForAutoRetry,
  MAX_PENDING_BATCHES, QUEUE_EVENT, retryDelayMs, sessionScope
} from './offlineSyncModel.js';
import { indexedDbQueueStore } from './offlineQueueStore.js';
import { reconcileOfflineDraft } from './offlineReconciliation.js';
import { planConfirmedPhotoRecovery, verifiedPhotoUpload } from './photoRecovery.js';
import { validateOfflinePhoto } from './offlinePhoto.js';
import { assertStorageCapacity, browserStorageStatus } from './offlineStorageStatus.js';

const changes = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_EVENT));
};

export function createOfflineQueue({
  store,
  notify = () => {},
  uuid = () => crypto.randomUUID(),
  now = () => new Date(),
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
  withLock = async (_scope, handler) => handler()
}) {
  const inFlightScopes = new Set();

  async function list(session) {
    const scope = sessionScope(session);
    if (!scope) return [];
    return store.list(scope);
  }

  async function queueObservation(session, runId, values) {
    const scope = sessionScope(session);
    if (!scope) throw new Error('Conectá tu cuenta para guardar observaciones pendientes.');
    const pending = await store.list(scope);
    if (pending.length >= MAX_PENDING_BATCHES) {
      throw new Error(`La cola local llegó al límite de ${MAX_PENDING_BATCHES} observaciones.`);
    }
    const item = createPendingObservation({ session, runId, values, uuid, now: now() });
    // Advisory preflight. In private browsing / browsers lacking the Storage
    // API, the IndexedDB transaction is still authoritative for quota errors.
    const capacity = await browserStorageStatus().catch(() => ({
      supported: false, quota: null, usage: null
    }));
    assertStorageCapacity(capacity);
    await store.put(item);
    notify();
    return item;
  }

  async function discard(session, id) {
    const scope = sessionScope(session);
    if (!scope || !id.startsWith(`${scope}:`)) throw new Error('Esta operación pertenece a otra sesión.');
    const item = await store.get(id);
    if (!item || item.scope !== scope) throw new Error('Operación local no encontrada.');
    if (await store.delete(id, { expected: item }) === false) {
      throw new Error('La captura cambió en otra pestaña. Actualizá antes de eliminar.');
    }
    notify();
  }

  async function allowRetry(session, id, { notifyChange = true } = {}) {
    const scope = sessionScope(session);
    const item = scope && await store.get(id);
    if (!item || item.scope !== scope) throw new Error('Operación local no encontrada.');
    const saved = await store.put({
      ...item, state: 'pending', nextRetryAt: null, lastError: null, errorCode: null
    }, { expected: item });
    if (saved === false) {
      throw new Error('Otra pestaña modificó esta captura. Actualizá antes de reintentar.');
    }
    if (notifyChange) notify();
  }

  // Requires a fresh server receipt obtained via GET /sync/my-batches and
  // explicit user confirmation. Never use this for a draft with local evidence:
  // batch receipts do NOT prove that the separate photo upload succeeded.
  async function confirmApplied(session, id, receipt) {
    const scope = sessionScope(session);
    if (!scope || typeof id !== 'string' || !id.startsWith(`${scope}:`)) {
      throw new Error('Esta operación pertenece a otra sesión.');
    }
    if (inFlightScopes.has(scope)) return false;
    inFlightScopes.add(scope);
    try {
      const result = await withLock(scope, async () => {
        const current = await store.get(id);
        if (!current || current.scope !== scope) return false;
        const verified = reconcileOfflineDraft(current, [receipt], session);
        if (verified.status !== 'confirmed' || current.evidence) {
          throw new Error('No hay un recibo completo y seguro para retirar este borrador.');
        }
        if (await store.delete(id, { expected: current }) === false) return false;
        notify();
        return true;
      });
      return result === true;
    } finally {
      inFlightScopes.delete(scope);
    }
  }

  // Manual photo-only recovery after a FRESH personal sync receipt. Does not
  // re-POST the observation batch, mutate its stable UUID, or send coordinates.
  // Both this method and flush hold the same scope lock across all HTTP writes.
  async function recoverPhoto(session, id, receipt, sendEvidence) {
    const scope = sessionScope(session);
    if (!scope || typeof id !== 'string' || !id.startsWith(`${scope}:`)) {
      throw new Error('Esta fotografía pertenece a otra sesión.');
    }
    if (typeof sendEvidence !== 'function') {
      throw new Error('La carga de fotografías no está disponible.');
    }
    if (!isOnline()) return { status: 'offline' };
    if (inFlightScopes.has(scope)) return { status: 'busy' };
    inFlightScopes.add(scope);
    try {
      const result = await withLock(scope, async () => {
        const current = await store.get(id);
        if (!current || current.scope !== scope) return { status: 'missing' };
        // Fail closed BEFORE HTTP if the observation or photo identity differs.
        const plan = planConfirmedPhotoRecovery(current, receipt, session);
        try {
          const uploaded = await sendEvidence(plan.observationId, current.evidence);
          const confirmed = verifiedPhotoUpload(uploaded, plan);
          const latest = await store.get(id);
          if (!latest || latest.scope !== scope) return { status: 'missing' };
          if (JSON.stringify(latest) !== JSON.stringify(current)) {
            return { status: 'changed' };
          }
          if (await store.delete(id, { expected: current }) === false) {
            return { status: 'changed' };
          }
          notify();
          return { status: 'uploaded', evidenceId: confirmed.evidenceId,
            replayed: confirmed.replayed };
        } catch (error) {
          // Incomplete/lost ACK is not proof of failure on PostgreSQL. Keep
          // the original bytes and client_upload_id for idempotent replay.
          const latest = await store.get(id);
          if (!latest || latest.scope !== scope) return { status: 'missing' };
          if (JSON.stringify(latest) !== JSON.stringify(current)) {
            return { status: 'changed' };
          }
          const outcome = classifySyncError(error);
          const attempts = latest.attempts + 1;
          const saved = await store.put({
            ...latest,
            attempts,
            state: outcome === 'retry' ? 'pending' : outcome,
            errorCode: typeof error?.code === 'string' ? error.code.slice(0, 64) : null,
            lastError: String(error?.message || 'No se confirmó la fotografía.').slice(0, 220),
            nextRetryAt: outcome === 'retry'
              ? new Date(now().getTime() + retryDelayMs(attempts)).toISOString() : null
          }, { expected: current });
          if (saved === false) return { status: 'changed' };
          notify();
          return { status: outcome === 'retry' ? 'pending' : outcome };
        }
      });
      return result?.status ? result : { status: 'busy' };
    } finally {
      inFlightScopes.delete(scope);
    }
  }

  async function flush(session, send, {
    force = false, sendEvidence = null, onlyId = null, manualReview = false
  } = {}) {
    const scope = sessionScope(session);
    const single = onlyId !== null;
    // Never use a display filter as permission to send an arbitrary ID.
    if (single && (!scope || typeof onlyId !== 'string' ||
      !onlyId.startsWith(`${scope}:`) ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
        onlyId.slice(scope.length + 1)))) {
      throw new Error('Esta captura pertenece a otra cuenta o no tiene un ID válido.');
    }
    if (!scope || !isOnline()) return { attempted: 0, sent: 0, conflicts: 0, skipped: true };
    if (inFlightScopes.has(scope)) return { attempted: 0, sent: 0, conflicts: 0, skipped: true };
    inFlightScopes.add(scope);
    try {
      return await withLock(scope, async () => {
        // A selected retry reads ONLY that encrypted draft. The global path
        // keeps its existing FIFO scan, eligibility and retry behavior.
        const items = single
          ? [await store.get(onlyId)].filter(Boolean) : await store.list(scope);
        const summary = { attempted: 0, sent: 0, conflicts: 0, skipped: false };
        if (single && !items.length) return { ...summary, missing: true };
        for (const saved of items) {
          if (single && (saved.id !== onlyId || saved.scope !== scope ||
            saved.id !== `${scope}:${saved.idempotencyKey}` ||
            saved.body?.idempotency_key !== saved.idempotencyKey ||
            !Array.isArray(saved.body?.operations) ||
            saved.body.operations.length !== 1 ||
            saved.body.operations[0]?.entity_type !== 'scouting_observation' ||
            saved.body.operations[0]?.operation !== 'create' ||
            saved.body.operations[0]?.payload?.scouting_run_id !== saved.runId)) {
            return { ...summary, invalidDraft: true };
          }
          if (single && saved.evidence && saved.syncedObservationId) {
            // 0S.6: observation already succeeded. Require a fresh personal
            // receipt and an independent photo-only ACK, not another batch.
            return { ...summary, photoRecoveryRequired: true };
          }
          if (saved.state !== 'pending' && !(
            single && manualReview && ['auth', 'conflict'].includes(saved.state))) continue;
          if (!single && !force && !isEligibleForAutoRetry(saved, now().getTime())) continue;
          if (!isOnline()) break;
          const item = await store.get(saved.id);
          if (!item || item.scope !== scope) continue;
          if (single && (item.id !== onlyId ||
            item.id !== `${scope}:${item.idempotencyKey}` ||
            item.body?.idempotency_key !== item.idempotencyKey ||
            !Array.isArray(item.body?.operations) || item.body.operations.length !== 1 ||
            item.body.operations[0]?.entity_type !== 'scouting_observation' ||
            item.body.operations[0]?.operation !== 'create' ||
            item.body.operations[0]?.payload?.scouting_run_id !== item.runId)) {
            return { ...summary, invalidDraft: true };
          }
          if (single && item.evidence && item.syncedObservationId) {
            return { ...summary, photoRecoveryRequired: true };
          }
          if (item.state !== 'pending' && !(
            single && manualReview && ['auth', 'conflict'].includes(item.state))) continue;
          summary.attempted += 1;
          // Snapshot to protect against non-cooperating tabs that mutate or
          // discard the row while the network and photo upload are in flight.
          let expectedAfterWrite = item;
          try {
            const receipt = await send(item.body);
            // An unexpected empty or non-applied response is ambiguous. Preserve
            // the immutable batch for an idempotent retry rather than losing it.
            if (receipt?.data?.status !== 'processed' ||
                receipt?.data?.idempotency_key !== item.idempotencyKey ||
                receipt?.data?.operations?.length !== item.body.operations.length ||
                !receipt.data.operations.every((op, index) =>
                  op.status === 'applied' &&
                  op.entity_client_id === item.body.operations[index].entity_client_id &&
                  typeof op.result?.observation_id === 'string')) {
              throw new Error('La confirmación de sincronización no fue completa.');
            }
            if (item.evidence) {
              const operation = receipt.data.operations[0];
              const observationId = operation.result.observation_id;
              // The observation may have reached PostgreSQL before a disconnect.
              // Persist that partial success so the user can distinguish a
              // photo conflict from an entirely unsent observation.
              const current = await store.get(item.id);
              if (!current || JSON.stringify(current) !== JSON.stringify(item)) {
                continue; // changed/discarded during HTTP: never overwrite
              }
              const appliedDraft = { ...current, syncedObservationId: observationId };
              const applied = await store.put(appliedDraft, { expected: item });
              if (applied === false) continue;
              // The returned object carries the revision from THIS commit.
              // A later get could observe a new re-seal with identical data.
              expectedAfterWrite = appliedDraft;
              notify();
              if (typeof sendEvidence !== 'function') {
                throw new Error('El envío de fotografías no está disponible en este cliente.');
              }
              // An HTTP 2xx or a partial attachment receipt cannot prove this
              // exact user's image persisted. Match all immutable bindings
              // before removing encrypted offline bytes, exactly as the manual
              // photo-only recovery path already does.
              const photo = validateOfflinePhoto(item.evidence);
              const plan = {
                observationId,
                clientUploadId: item.evidence.client_upload_id,
                submittedBy: session.user.id,
                sizeBytes: photo.size_bytes,
                mimeType: photo.mime_type,
                originalName: photo.original_name
              };
              const uploaded = await sendEvidence(observationId, item.evidence);
              verifiedPhotoUpload(uploaded, plan);
            }
            const latest = await store.get(item.id);
            if (!latest || JSON.stringify(latest) !== JSON.stringify(expectedAfterWrite)) {
              continue; // another tab changed this row after HTTP success
            }
            if (await store.delete(item.id, { expected: expectedAfterWrite }) === false) {
              continue; // atomic CAS loss: do not report delivery as complete
            }
            summary.sent += 1;
            notify();
          } catch (error) {
            const state = classifySyncError(error);
            const attempts = item.attempts + 1;
            // The user may have discarded this draft while it was being sent.
            // Never resurrect locally removed data after a failed request.
            const current = await store.get(item.id);
            if (!current || current.scope !== scope ||
                JSON.stringify(current) !== JSON.stringify(expectedAfterWrite)) continue;
            const saved = await store.put({
              ...current, attempts, state: state === 'retry' ? 'pending' : state,
              errorCode: typeof error?.code === 'string' ? error.code.slice(0, 64) : null,
              lastError: String(error?.message || 'No se pudo enviar.').slice(0, 220),
              nextRetryAt: state === 'retry'
                ? new Date(now().getTime() + retryDelayMs(attempts)).toISOString() : null
            }, { expected: expectedAfterWrite });
            if (saved === false) continue;
            if (state === 'conflict') summary.conflicts += 1;
            notify();
            // Authentication needs a new session; network/backend failures should
            // not cause an unbounded loop and block the rest of the browser.
            if (state === 'auth' || state === 'retry') break;
          }
        }
        return summary;
      });
    } finally {
      inFlightScopes.delete(scope);
    }
  }

  // Exposes one-shot manual delivery without changing auto-flush semantics
  // or preemptively rewriting conflict/auth records before the network call.
  async function flushOne(session, id, send, { sendEvidence = null } = {}) {
    return flush(session, send, {
      onlyId: id, force: true, manualReview: true, sendEvidence
    });
  }

  return {
    list, queueObservation, discard, allowRetry, confirmApplied, recoverPhoto,
    flush, flushOne
  };
}

async function lockAcrossTabs(scope, handler) {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return handler();
  return navigator.locks.request(`sedeagro:sync:${scope}`, { ifAvailable: true },
    (lock) => lock ? handler() : ({ attempted: 0, sent: 0, conflicts: 0, skipped: true }));
}

export const offlineQueue = createOfflineQueue({
  store: indexedDbQueueStore,
  notify: changes,
  withLock: lockAcrossTabs
});
