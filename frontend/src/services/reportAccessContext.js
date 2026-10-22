import { sessionScope } from './offlineSyncModel.js';

// A report can contain information beyond a single field: campaign, scouting
// observations, orders and exports. A tenant:user key alone is insufficient
// after live role/entitlement changes during a pending browser request.
export function reportAccessContext(session, dataMode, fieldId = null) {
  const principal = dataMode === 'live' ? sessionScope(session) : null;
  if (!principal) return null;
  const entitlements = Array.isArray(session?.entitlements)
    ? [...new Set(session.entitlements.filter(value => typeof value === 'string'))].sort()
    : [];
  return JSON.stringify([
    principal,
    session?.membership?.roleCode || '',
    session?.user?.isPlatformAdmin === true,
    entitlements,
    fieldId || null
  ]);
}

// Do not trust a valid HTTP 200 as proof that the summary matches the field
// selected in the UI. This mirrors the real reports/field/:fieldId contract.
export function confirmFieldReportResponse(response, fieldId) {
  const report = response?.data;
  if (!fieldId || typeof report !== 'object' || !report ||
      report.field?.id !== fieldId) {
    throw new Error('El servidor no confirmó el resumen del lote seleccionado.');
  }
  return report;
}

// Rendering must never wait for an effect to clear old private data. A stale
// state object from another actor, field or API instance is not visible.
export function visibleFieldReport(snapshot, context, api) {
  return snapshot?.scope === context && snapshot?.api === api
    ? snapshot.report : null;
}
