import { sessionScope } from './offlineSyncModel.js';

// A report can contain information beyond a single field: campaign, scouting
// observations, orders and exports. A tenant:user key alone is insufficient
// after live role/entitlement changes during a pending browser request.
export function reportAccessContext(session, dataMode, fieldId = null) {
  const principal = dataMode === 'live' ? sessionScope(session) : null;
  // Membership replacements can change report/export authorization even
  // with the same account, tenant and role. Never reuse the prior report view.
  const membershipId = session?.membership?.id;
  if (!principal || !membershipId) return null;
  const entitlements = Array.isArray(session?.entitlements)
    ? [...new Set(session.entitlements.filter(value => typeof value === 'string'))].sort()
    : [];
  return JSON.stringify([
    principal,
    membershipId,
    session?.membership?.roleCode || '',
    session?.user?.isPlatformAdmin === true,
    entitlements,
    fieldId || null
  ]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXACT_COLUMNS = ['execution_id', 'work_order_id', 'field_id', 'title', 'finished_at'];

export function canOpenFieldReviewOrders(session, dataMode) {
  return Boolean(dataMode === 'live' && sessionScope(session) &&
    session?.membership?.id &&
    ['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode) &&
    Array.isArray(session?.entitlements) &&
    session.entitlements.includes('reports') &&
    session.entitlements.includes('work_orders'));
}

export function checkedFieldReviewSummary(summary, fieldId) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary) ||
      Object.keys(summary).some(k => !['submitted', 'verified', 'rejected', 'recentPending'].includes(k)) ||
      !['submitted', 'verified', 'rejected'].every(k =>
        Number.isSafeInteger(summary[k]) && summary[k] >= 0) ||
      !Array.isArray(summary.recentPending) || summary.recentPending.length > 5 ||
      summary.recentPending.length > summary.submitted) {
    throw new Error('El servidor devolvió un resumen de revisiones inválido.');
  }
  const seen = new Set();
  for (const row of summary.recentPending) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).sort().join('|') !== [...EXACT_COLUMNS].sort().join('|') ||
        row.field_id !== fieldId || !UUID.test(row.execution_id) ||
        !UUID.test(row.work_order_id) ||
        typeof row.title !== 'string' || !row.title.trim() || row.title.length > 250 ||
        typeof row.finished_at !== 'string' ||
        !Number.isFinite(Date.parse(row.finished_at)) ||
        seen.has(row.execution_id) || seen.has(row.work_order_id)) {
      throw new Error('El servidor devolvió órdenes pendientes ajenas o inválidas.');
    }
    seen.add(row.execution_id);
    seen.add(row.work_order_id);
  }
  return summary;
}

// Do not trust a valid HTTP 200 as proof that the summary matches the field
// selected in the UI. This mirrors the real reports/field/:fieldId contract.
export function confirmFieldReportResponse(response, fieldId) {
  const report = response?.data;
  if (!fieldId || typeof report !== 'object' || !report ||
      report.field?.id !== fieldId) {
    throw new Error('El servidor no confirmó el resumen del lote seleccionado.');
  }
  checkedFieldReviewSummary(report.reviewSummary, fieldId);
  return report;
}

// Rendering must never wait for an effect to clear old private data. A stale
// state object from another actor, field or API instance is not visible.
export function visibleFieldReport(snapshot, context, api) {
  return snapshot?.scope === context && snapshot?.api === api
    ? snapshot.report : null;
}
