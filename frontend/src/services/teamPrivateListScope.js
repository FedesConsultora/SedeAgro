import { sessionScope } from './offlineSyncModel.js';

// Private list render fence: a backend /members or /teams response belongs
// exclusively to the authenticated actor, membership, tenant and entitlement
// snapshot that requested it. The backend remains responsible for capabilities.
export function teamPrivateListScope(session, dataMode) {
  if (dataMode === 'mock') return 'demo';
  if (dataMode !== 'live' || session?.authenticated !== true) return null;
  const principal = sessionScope(session);
  if (!principal || !session?.membership?.id ||
      !Array.isArray(session.entitlements) || !session.entitlements.includes('org')) return null;
  return JSON.stringify([
    principal, session.membership.id, session.membership.roleCode || '',
    [...new Set(session.entitlements.filter(x => typeof x === 'string'))].sort()
  ]);
}

export function checkedTeamPrivateRows(rows, tenantId, collection) {
  if (!Array.isArray(rows)) throw new Error('Lista inválida de ' + collection + '.');
  if (!tenantId) return rows; // mock data never gets mixed with authenticated lists.
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) ||
      typeof row.id !== 'string' ||
      (row.tenant_id != null && row.tenant_id !== tenantId))) {
    throw new Error('El servidor devolvió ' + collection + ' de otra empresa.');
  }
  return rows;
}
