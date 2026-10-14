// Shared guards keep the tenant GUC transaction-local and reject privileged runtime roles.
export const SET_TENANT_SQL = "SELECT set_config('app.current_tenant', :tenantId, true) AS tenant_id";

export function assertTenantTransaction(transaction, tenantId) {
  if (!transaction || transaction.finished) {
    throw new Error('Tenant context requires an active database transaction.');
  }
  if (typeof tenantId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error('Tenant context requires a valid UUID.');
  }
}

export function isSafeRuntimeDbRole(role) {
  return Boolean(role &&
    typeof role.rolname === 'string' &&
    typeof role.db_owner === 'string' &&
    role.rolname !== role.db_owner &&
    role.rolsuper === false &&
    role.rolbypassrls === false &&
    role.rolcreaterole === false &&
    role.rolcreatedb === false);
}
