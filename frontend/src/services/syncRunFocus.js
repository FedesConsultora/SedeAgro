// Pure, read-only route context for the field Sync screen. A focused
// run must match real backend UUIDs; an invalid focus NEVER falls back
// to displaying every tenant row.
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function resolveSyncRunFocus(focusRunId) {
  if (focusRunId == null) return { mode: 'all', runId: null };
  if (typeof focusRunId === 'string' && UUID.test(focusRunId)) {
    return { mode: 'run', runId: focusRunId };
  }
  return { mode: 'invalid', runId: null };
}

export function filterSyncRunDrafts(drafts, scope, focus) {
  if (!scope || !Array.isArray(drafts)) return [];
  const own = drafts.filter(item => item?.scope === scope);
  if (focus?.mode === 'all') return own;
  if (focus?.mode !== 'run') return [];
  return own.filter(item => item.runId === focus.runId &&
    item.body?.operations?.length === 1 &&
    item.body.operations[0]?.payload?.scouting_run_id === focus.runId);
}

export function filterSyncRunReceipts(receipts, focus) {
  if (!Array.isArray(receipts)) return [];
  if (focus?.mode === 'all') return receipts;
  if (focus?.mode !== 'run') return [];
  // GET /sync/my-batches and GET /sync/batches return
  // SyncOperations[].result.scouting_run_id from committed operations.
  // A failed/old batch with no reliable result CANNOT be attributed
  // to a run just by its idempotency key, client_id or screen filter.
  return receipts.filter(batch =>
    Array.isArray(batch?.SyncOperations) && batch.SyncOperations.some(operation =>
      operation?.result?.scouting_run_id === focus.runId));
}
