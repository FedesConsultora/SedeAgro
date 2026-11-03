// Bounded transport envelope for write-only offline operations. A timeout is
// NOT proof that a POST failed: the server may have committed before the ACK
// vanished. The queue must retain its immutable idempotency key and ciphertext.
export const OFFLINE_BATCH_DEADLINE_MS = 25_000;
export const OFFLINE_PHOTO_DEADLINE_MS = 35_000;

const abortedError = () => new DOMException(
  'La conexión no confirmó el envío dentro del plazo. Conservá la captura para recuperar el recibo.',
  'AbortError'
);

/**
 * Abort a hung fetch and also settle the caller if the underlying transport
 * ignores abort. This unblocks the account-scoped lock while preserving the
 * encrypted draft; the retry uses the SAME immutable UUID and server receipt.
 * The optional parent signal fences logout/account changes immediately.
 */
export async function withOfflineTransportDeadline(transport, {
  signal: parentSignal = null, timeoutMs = OFFLINE_BATCH_DEADLINE_MS
} = {}) {
  if (typeof transport !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new TypeError('Parámetros inválidos para el límite de transporte offline.');
  }
  const controller = new AbortController();
  const parentAborted = () => controller.abort(parentSignal?.reason || abortedError());
  if (parentSignal?.aborted) parentAborted();
  else parentSignal?.addEventListener('abort', parentAborted, { once: true });

  let rejectOnAbort;
  const cancelled = new Promise((_, reject) => {
    rejectOnAbort = reject;
  });
  const abort = () => rejectOnAbort(controller.signal.reason || abortedError());
  controller.signal.addEventListener('abort', abort, { once: true });

  const timer = setTimeout(() => controller.abort(abortedError()), timeoutMs);
  try {
    if (controller.signal.aborted) throw controller.signal.reason || abortedError();
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason || abortedError();
        return transport(controller.signal);
      }),
      cancelled
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    parentSignal?.removeEventListener('abort', parentAborted);
  }
}
