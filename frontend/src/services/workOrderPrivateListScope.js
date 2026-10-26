// A private orders snapshot belongs to exactly one authenticated principal,
// membership, role, capability set and API transport. This is a presentation
// fence, not a replacement for server-side tenant RLS or authorization.
export function workOrderPrivateListScope(session, dataMode) {
  if (dataMode === 'mock') return 'demo';
  if (dataMode !== 'live' || session?.authenticated !== true) return null;
  const tenantId = session?.tenant?.id;
  const userId = session?.user?.id;
  const membershipId = session?.membership?.id;
  const role = session?.membership?.roleCode;
  const entitlements = session?.entitlements;
  if (!tenantId || !userId || !membershipId || !role ||
      !Array.isArray(entitlements) || !entitlements.includes('work_orders')) return null;
  return JSON.stringify([tenantId, userId, membershipId, role,
    [...new Set(entitlements.filter(item => typeof item === 'string'))].sort()]);
}

export function checkedWorkOrderPrivateRows(rows, tenantId) {
  if (!tenantId || !Array.isArray(rows) || rows.some(row =>
    !row || typeof row !== 'object' || Array.isArray(row) ||
    typeof row.id !== 'string' || !row.id ||
    (row.tenant_id != null && row.tenant_id !== tenantId))) {
    throw new Error('El servidor devolvió órdenes inválidas o de otra empresa.');
  }
  return rows;
}

export function visibleWorkOrderPrivateSnapshot(snapshot, scope, api, revision) {
  return scope && snapshot?.scope === scope && snapshot?.api === api &&
    snapshot?.revision === revision ? snapshot : null;
}

export function visibleWorkOrderPrivateSelection(selection, scope, api, revision) {
  return scope && selection?.scope === scope && selection?.api === api &&
    selection?.revision === revision ? selection.order : null;
}
