import {
  classifySyncError, createPendingObservation, isEligibleForAutoRetry,
  MAX_PENDING_BATCHES, QUEUE_EVENT, retryDelayMs, sessionScope
} from './offlineSyncModel.js';
import { indexedDbQueueStore } from './offlineQueueStore.js';

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
    await store.put(item);
    notify();
    return item;
  }

  async function discard(session, id) {
    const scope = sessionScope(session);
    if (!scope || !id.startsWith(`${scope}:`)) throw new Error('Esta operación pertenece a otra sesión.');
    const item = await store.get(id);
    if (!item || item.scope !== scope) throw new Error('Operación local no encontrada.');
    await store.delete(id);
    notify();
  }

  async function allowRetry(session, id) {
    const scope = sessionScope(session);
    const item = scope && await store.get(id);
    if (!item || item.scope !== scope) throw new Error('Operación local no encontrada.');
    await store.put({
      ...item, state: 'pending', nextRetryAt: null, lastError: null, errorCode: null
    });
    notify();
  }

  async function flush(session, send, { force = false } = {}) {
    const scope = sessionScope(session);
    if (!scope || !isOnline()) return { attempted: 0, sent: 0, conflicts: 0, skipped: true };
    if (inFlightScopes.has(scope)) return { attempted: 0, sent: 0, conflicts: 0, skipped: true };
    inFlightScopes.add(scope);
    try {
      return await withLock(scope, async () => {
        const items = await store.list(scope);
        const summary = { attempted: 0, sent: 0, conflicts: 0, skipped: false };
        for (const saved of items) {
          if (saved.state !== 'pending') continue;
          if (!force && !isEligibleForAutoRetry(saved, now().getTime())) continue;
          if (!isOnline()) break;
          const item = await store.get(saved.id);
          if (!item || item.scope !== scope || item.state !== 'pending') continue;
          summary.attempted += 1;
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
            await store.delete(item.id);
            summary.sent += 1;
            notify();
          } catch (error) {
            const state = classifySyncError(error);
            const attempts = item.attempts + 1;
            // The user may have discarded this draft while it was being sent.
            // Never resurrect locally removed data after a failed request.
            const current = await store.get(item.id);
            if (!current || current.scope !== scope) continue;
            await store.put({
              ...current, attempts, state: state === 'retry' ? 'pending' : state,
              errorCode: typeof error?.code === 'string' ? error.code.slice(0, 64) : null,
              lastError: String(error?.message || 'No se pudo enviar.').slice(0, 220),
              nextRetryAt: state === 'retry'
                ? new Date(now().getTime() + retryDelayMs(attempts)).toISOString() : null
            });
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

  return { list, queueObservation, discard, allowRetry, flush };
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
