import { sessionScope } from './offlineSyncModel.js';

// Authentication/session changes invalidate server receipts even for two
// memberships of the same actor in the same company. This is only a UI fence:
// backend auth and FORCE RLS remain the security authority.
export function syncReceiptPresentationScope(session, dataMode) {
  if (dataMode === 'mock') return 'demo';
  if (dataMode !== 'live' || session?.authenticated !== true) return null;
  const principal = sessionScope(session);
  const member = session?.membership;
  const entitlements = session?.entitlements;
  if (!principal || !member?.id || !member?.roleCode ||
      !Array.isArray(entitlements) || !entitlements.includes('scouting')) return null;
  return JSON.stringify([principal, member.id, member.roleCode,
    [...new Set(entitlements.filter(x => typeof x === 'string'))].sort()]);
}

export function visibleSyncReceiptRows(rows, loadedScope, loadedApi, scope, api) {
  return scope && loadedScope === scope && loadedApi === api && Array.isArray(rows)
    ? rows : [];
}

export function checkedSyncReceiptRows(rows, tenantId) {
  if (!Array.isArray(rows) || rows.some(row =>
    !row || typeof row !== 'object' || Array.isArray(row) ||
    typeof row.id !== 'string' || !row.id ||
    (row.tenant_id != null && row.tenant_id !== tenantId))) {
    throw new Error('El servidor devolvió recibos inválidos o de otra empresa.');
  }
  return rows;
}
