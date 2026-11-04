// A single authoritative RLS-bounded snapshot shared by CSV, PDF and XLSX.
import { Op, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { Field, Farm, ScoutingObservation, WorkOrder } from '../../models/index.js';
import { HttpError } from '../../utils/http.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { fieldCsvPeriod, FIELD_CSV_MAX_ROWS_PER_KIND } from './fieldCsv.js';

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
}).strict();

export async function loadFieldReportSnapshot(req) {
  // Validate before any database read. Never assign to Express's readonly
  // req.query getter (Express 5 compatibility).
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(422, 'Parámetros de fecha inválidos.', parsed.error.flatten());
  if (!z.string().uuid().safeParse(req.params.fieldId).success) {
    throw new HttpError(422, 'Identificador de lote inválido.');
  }
  let period;
  try {
    period = fieldCsvPeriod(parsed.data.from, parsed.data.to);
  } catch (error) {
    throw new HttpError(422, error.message);
  }
  const tx = req.dbTransaction;
  const field = await Field.findOne({
    where: { id: req.params.fieldId, tenant_id: req.tenantId },
    attributes: ['id', 'name', 'area_hectares'],
    include: [{ model: Farm, attributes: ['id', 'name'] }],
    transaction: tx
  });
  if (!field) throw new HttpError(404, 'Lote no encontrado.');
  const dateBounds = {
    ...(period.start ? { [Op.gte]: period.start } : {}),
    ...(period.exclusiveEnd ? { [Op.lt]: period.exclusiveEnd } : {})
  };
  const boundedAt = (name) => period.start || period.exclusiveEnd ? { [name]: dateBounds } : {};
  const observations = await ScoutingObservation.findAll({
    where: {
      tenant_id: req.tenantId, field_id: field.id,
      ...boundedAt('observed_at')
    },
    attributes: ['id', 'observed_at', 'observation_type', 'severity', 'notes'],
    order: [['observed_at', 'DESC'], ['id', 'DESC']],
    limit: FIELD_CSV_MAX_ROWS_PER_KIND + 1, transaction: tx
  });
  const workOrders = await WorkOrder.findAll({
    where: {
      tenant_id: req.tenantId, field_id: field.id,
      ...boundedAt('created_at')
    },
    attributes: ['id', 'created_at', 'type', 'status', 'priority', 'title'],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: FIELD_CSV_MAX_ROWS_PER_KIND + 1, transaction: tx
  });
  if (observations.length > FIELD_CSV_MAX_ROWS_PER_KIND ||
      workOrders.length > FIELD_CSV_MAX_ROWS_PER_KIND) {
    throw new HttpError(413, 'Demasiados registros para exportar. Elegí un período más corto.',
      undefined, 'REPORT_EXPORT_TOO_LARGE');
  }
  // Read only provenance belonging to the SAME bounded work-order snapshot.
  // The reporting role is admin/coordinator and reports.read is already
  // server-checked. No scouting notes/GPS/evidence are joined or exposed.
  const orderIds = workOrders.map(item => item.id);
  const linked = orderIds.length ? await queryTenantTransaction(`
    SELECT work_order_id, scouting_observation_id, scouting_run_id
    FROM work_order_observation_origins
    WHERE tenant_id = :tenant AND field_id = :field
      AND work_order_id IN (:orderIds)
  `, { transaction: tx, type: QueryTypes.SELECT, replacements: {
    tenant: req.tenantId, field: field.id, orderIds
  } }) : [];
  // Execution dates belong to the WORK actually performed, not the date
  // the original order was created. A period can therefore include executions
  // of orders created before its start. Bound by field, tenant and finished_at
  // under the same tenant RLS transaction as observations and orders.
  const clauses = ['e.tenant_id = :tenant', 'o.field_id = :field'];
  const executionReplacements = { tenant: req.tenantId, field: field.id,
    limit: FIELD_CSV_MAX_ROWS_PER_KIND + 1 };
  if (period.start) {
    clauses.push('e.finished_at >= :start');
    executionReplacements.start = period.start;
  }
  if (period.exclusiveEnd) {
    clauses.push('e.finished_at < :exclusiveEnd');
    executionReplacements.exclusiveEnd = period.exclusiveEnd;
  }
  const executions = await queryTenantTransaction(`
    SELECT e.id, e.work_order_id, e.started_at, e.finished_at,
      e.worked_area_hectares, e.result_summary, e.review_status, e.reviewed_at,
      o.type AS work_order_type, o.priority AS work_order_priority,
      origin.scouting_observation_id, origin.scouting_run_id
    FROM work_order_executions AS e
    INNER JOIN work_orders AS o
      ON o.tenant_id = e.tenant_id AND o.id = e.work_order_id
    LEFT JOIN work_order_observation_origins AS origin
      ON origin.tenant_id = e.tenant_id AND origin.work_order_id = e.work_order_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY e.finished_at DESC, e.id DESC
    LIMIT :limit
  `, { transaction: tx, type: QueryTypes.SELECT, replacements: executionReplacements });
  if (executions.length > FIELD_CSV_MAX_ROWS_PER_KIND) {
    throw new HttpError(413, 'Demasiadas ejecuciones para exportar. Elegí un período más corto.',
      undefined, 'REPORT_EXPORT_TOO_LARGE');
  }
  const origins = new Map(linked.map(item => [item.work_order_id, {
    scouting_observation_id: item.scouting_observation_id,
    scouting_run_id: item.scouting_run_id
  }]));
  return {
    field: field.get({ plain: true }),
    observations: observations.map(item => item.get({ plain: true })),
    workOrders: workOrders.map(item => ({
      ...item.get({ plain: true }),
      ...(origins.has(item.id) ? { observation_origin: origins.get(item.id) } : {})
    })),
    executions,
    period
  };
}
