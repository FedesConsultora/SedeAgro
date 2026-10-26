// Rendering private offline notes/photos must not rely on a later React
// effect to clear a previous actor's state. This scope is presentation-only:
// the encrypted queue still enforces its own authenticated actor/tenant key.
export function observationCaptureViewScope(session, dataMode, runId) {
  if (typeof runId !== 'string' || !runId) return null;
  if (dataMode === 'mock') return JSON.stringify(['demo', runId]);
  if (dataMode !== 'live' || session?.authenticated !== true) return null;
  const tenant = session?.tenant?.id;
  const actor = session?.user?.id;
  const membership = session?.membership;
  const entitlements = session?.entitlements;
  if (!tenant || !actor || !membership?.id || !membership?.roleCode ||
      !Array.isArray(entitlements) || !entitlements.includes('scouting')) return null;
  return JSON.stringify([tenant, actor, membership.id, membership.roleCode,
    [...new Set(entitlements.filter(x => typeof x === 'string'))].sort(), runId]);
}

export function visibleObservationCapture(snapshot, scope) {
  return scope && snapshot?.scope === scope ? snapshot.value : null;
}
