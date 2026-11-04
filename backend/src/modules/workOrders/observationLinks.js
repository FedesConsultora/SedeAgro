import { QueryTypes } from 'sequelize';
import { ScoutingRun } from '../../models/index.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { HttpError } from '../../utils/http.js';
import { canReadObservationOrigin } from './observationOrigin.js';

// The reverse link is metadata for a coordinating agronomist, not permission
// to read observations or private evidence. The same tenant-scoped transaction
// is used for run validation and for the SQL join.
export const MAX_OBSERVATION_ORDER_LINKS = 100;

export async function readObservationWorkOrderLinks(req, runId) {
  if (!['tenant_admin', 'agronomic_coordinator'].includes(req.auth?.role?.code) ||
      !(await canReadObservationOrigin(req))) {
    throw new HttpError(403, 'No tenés permiso para consultar órdenes de origen.',
      undefined, 'ORDER_OBSERVATION_LINKS_FORBIDDEN');
  }
  const run = await ScoutingRun.findOne({
    where: { id: runId, tenant_id: req.tenantId },
    attributes: ['id'],
    transaction: req.dbTransaction
  });
  if (!run) {
    throw new HttpError(404, 'Recorrida no encontrada.',
      undefined, 'ORDER_OBSERVATION_LINKS_RUN_NOT_FOUND');
  }
  // The link table and both parents have FORCE RLS. Composite parent FKs
  // ensure these IDs really refer to the same tenant, campaign and lot.
  // Fail closed rather than advertise a truncated "complete" list.
  const rows = await queryTenantTransaction(`
    SELECT link.scouting_observation_id, link.work_order_id,
           orders.title, orders.type, orders.status, orders.priority
    FROM work_order_observation_origins AS link
    INNER JOIN work_orders AS orders
      ON orders.tenant_id = link.tenant_id
     AND orders.id = link.work_order_id
    WHERE link.tenant_id = :tenant AND link.scouting_run_id = :runId
    ORDER BY link.created_at DESC, link.work_order_id DESC
    LIMIT :limit
  `, { transaction: req.dbTransaction, replacements: {
    tenant: req.tenantId, runId, limit: MAX_OBSERVATION_ORDER_LINKS + 1
  }, type: QueryTypes.SELECT });
  if (rows.length > MAX_OBSERVATION_ORDER_LINKS) {
    throw new HttpError(409,
      'Esta recorrida supera el límite de órdenes vinculadas. No se puede mostrar un listado parcial.',
      undefined, 'ORDER_OBSERVATION_LINKS_LIMIT');
  }
  return rows;
}
