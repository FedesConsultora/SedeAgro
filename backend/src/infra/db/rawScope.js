import { QueryTypes } from 'sequelize';
import { sequelize } from '../../core/db.js';
import { getTenantId } from '../../core/tenantContext.js';
import { HttpError } from '../../utils/http.js';

export async function queryTenant(sql, replacements = {}, options = {}) {
  const tenantId = getTenantId();
  if (!tenantId) throw new HttpError(500, 'No hay tenant activo para ejecutar SQL tenant-scoped.');
  if (!/\btenant_id\b/i.test(sql)) {
    throw new HttpError(500, 'La consulta cruda debe incluir tenant_id explícitamente.');
  }

  return sequelize.query(sql, {
    type: QueryTypes.SELECT,
    ...options,
    replacements: {
      ...replacements,
      tenant_id: tenantId
    }
  });
}

// Explicit tenant + active transaction for atomic UPDATE/INSERT/DELETE and
// SELECT ... FOR UPDATE. This is not a bypass: the caller must have installed
// the transaction-local RLS GUC via setLocalTenant. SQL must scope tenant_id.
import { assertTenantTransaction } from '../../core/tenantDbSafety.js';
export async function queryTenantTransaction(sql, { transaction, replacements = {}, ...options } = {}) {
  const tenantId = replacements.tenant;
  assertTenantTransaction(transaction, tenantId);
  if (!/\btenant_id\b/i.test(sql)) {
    throw new HttpError(500, 'Tenant SQL must mention tenant_id explicitly.');
  }
  return sequelize.query(sql, { ...options, transaction, replacements });
}
