// Presentation contract for the scouting UI. The server remains the authority
// for tenant isolation, assignment and state transitions.
const RUN_STATUSES = new Set(['planned', 'in_progress', 'completed', 'cancelled']);
const CAN_PLAN = new Set(['tenant_admin', 'agronomic_coordinator']);

export function parseScoutingRuns(response) {
  const runs = response?.data;
  if (!Array.isArray(runs) || runs.some(run =>
    !run || typeof run.id !== 'string' || !run.id ||
    !RUN_STATUSES.has(run.status))) {
    throw new Error('El servidor respondió con una lista de recorridas inválida.');
  }
  return runs;
}

export function parseScoutingRunDetail(response, expectedId) {
  const run = response?.data;
  if (!run || typeof run !== 'object' || Array.isArray(run) ||
    !expectedId || run.id !== expectedId || !RUN_STATUSES.has(run.status) ||
    !Array.isArray(run.ScoutingObservations) ||
    run.ScoutingObservations.some(obs => !obs || typeof obs.id !== 'string' ||
      !Array.isArray(obs.EvidenceAssets))) {
    throw new Error('El servidor respondió con un detalle de recorrida inválido.');
  }
  return run;
}

export function isFocusedScoutingRunUnavailable(focusId, runs, loading, error) {
  return Boolean(focusId && !loading && !error && Array.isArray(runs) &&
    !runs.some(run => run.id === focusId));
}

export function scoutingRunCapabilities(run, session, dataMode) {
  const active = dataMode === 'live' && session?.authenticated === true &&
    !!session?.user?.id && !!session?.tenant?.id && !!run;
  const role = session?.membership?.roleCode;
  const canManage = active && CAN_PLAN.has(role);
  const canOperate = canManage || (active && role === 'scout' &&
    run.assigned_to === session.user.id);
  return {
    canManage: Boolean(canManage),
    canOperate: Boolean(canOperate),
    canObserve: Boolean(canOperate && ['planned', 'in_progress'].includes(run?.status))
  };
}
