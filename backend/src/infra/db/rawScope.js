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
