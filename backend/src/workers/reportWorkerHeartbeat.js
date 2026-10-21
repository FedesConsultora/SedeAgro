// Keep presence fresh independently of the renderer. Never overlap writes or
// disclose an underlying PostgreSQL error in the operational log.
export function startReportWorkerHeartbeat({ write, onFailure, intervalMs = 5000,
  schedule = setInterval, unschedule = clearInterval } = {}) {
  if (typeof write !== 'function' || typeof onFailure !== 'function' ||
      !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 15000) {
    throw new Error('Invalid report worker heartbeat configuration');
  }
  let stopped = false;
  let pending = null;
  let consecutiveFailures = 0;

  const tick = () => {
    if (stopped || pending) return pending || Promise.resolve();
    pending = (async () => {
      try {
        await write();
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
        // Log only a known reason code; DB exceptions may expose credentials.
        try { onFailure({ code: 'HEARTBEAT_WRITE_FAILED', consecutiveFailures }); } catch { /* no throw from timer */ }
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  const timer = schedule(() => { void tick(); }, intervalMs);
  return {
    tick,
    async stop() {
      stopped = true;
      unschedule(timer);
      if (pending) await pending;
    }
  };
}
