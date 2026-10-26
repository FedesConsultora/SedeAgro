// Render-time fencing for shared private collections (farms, campaigns,
// fields, reports). The current cookie/API and revision must match the
// response snapshot even before React effects execute after a session switch.
export function visibleTenantCollectionState(state, scope, api, revision) {
  return scope && state?.scope === scope && state?.api === api &&
    state?.revision === revision ? state : null;
}

// Optional tenant_id in list responses can prove that data is foreign.
// If the API omits tenant_id, authorization still belongs to the backend;
// the client never treats missing tenant_id as proof of ownership.
export function checkedTenantCollectionRows(rows, tenantId, title = 'recurso') {
  if (!tenantId || !Array.isArray(rows) || rows.some(row =>
    !row || typeof row !== 'object' || Array.isArray(row) ||
    (row.tenant_id != null && row.tenant_id !== tenantId))) {
    throw new Error('La lista de ' + title + ' contiene datos inválidos o de otra empresa.');
  }
  return rows;
}
