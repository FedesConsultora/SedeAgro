import { QueryTypes } from 'sequelize';
import { ScoutingObservation, ScoutingRun, TenantModule } from '../../models/index.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { hasCapability } from '../../infra/http/middlewares/requireCapability.js';
import { HttpError } from '../../utils/http.js';

// A work-order ID alone is not an authorization to see scouting data.
// The origin response contains identifiers only, never notes/GPS/photo bytes.
export async function canReadObservationOrigin(req) {
  if (!hasCapability(req.auth, req.tenantId, 'scouting.read')) return false;
  const module = await TenantModule.findOne({
    where: { tenant_id: req.tenantId, module_code: 'scouting', is_enabled: true },
    attributes: ['tenant_id'], transaction: req.dbTransaction, skipTenantScope: true
  });
  return Boolean(module);
}

export async function prepareObservationOrigin(req, input) {
  if (!input.origin_observation_id) return null;
  if (!input.campaign_field_id) {
    throw new HttpError(422, 'La orden originada en una observación requiere un lote de campaña.',
      undefined, 'ORDER_ORIGIN_CAMPAIGN_REQUIRED');
  }
  if (!(await canReadObservationOrigin(req))) {
    throw new HttpError(403, 'No tenés acceso vigente al origen de monitoreo.',
      undefined, 'ORDER_ORIGIN_SCOUTING_FORBIDDEN');
  }
  // Resolve the existing observation/run under the *request* tenant transaction,
  // not with a global lookup or trusting the client-supplied campaign.
  const observation = await ScoutingObservation.findOne({
    where: { tenant_id: req.tenantId, id: input.origin_observation_id },
    attributes: ['id', 'scouting_run_id', 'field_id'],
    transaction: req.dbTransaction,
    lock: req.dbTransaction.LOCK.SHARE
  });
  if (!observation) throw new HttpError(404, 'Observación de origen no encontrada.',
    undefined, 'ORDER_ORIGIN_OBSERVATION_NOT_FOUND');
  const run = await ScoutingRun.findOne({
    where: { tenant_id: req.tenantId, id: observation.scouting_run_id },
    attributes: ['id', 'campaign_field_id'],
    transaction: req.dbTransaction,
    lock: req.dbTransaction.LOCK.SHARE
  });
  if (!run) throw new HttpError(404, 'Recorrida de origen no encontrada.',
    undefined, 'ORDER_ORIGIN_RUN_NOT_FOUND');
  if (observation.field_id !== input.field_id ||
      run.campaign_field_id !== input.campaign_field_id) {
    throw new HttpError(422, 'La observación no corresponde al lote y campaña de la orden.',
      undefined, 'ORDER_ORIGIN_FIELD_CAMPAIGN_MISMATCH');
  }
  return Object.freeze({
    scouting_observation_id: observation.id,
    scouting_run_id: run.id,
    field_id: observation.field_id,
    campaign_field_id: run.campaign_field_id
  });
}

export async function persistObservationOrigin(req, orderId, origin) {
  if (!origin) return;
  // The three composite FKs enforce consistency even against later direct
  // SQL updates; the INSERT and work-order creation use one RLS transaction.
  await queryTenantTransaction(`
    INSERT INTO work_order_observation_origins
      (tenant_id, work_order_id, scouting_observation_id, scouting_run_id,
       field_id, campaign_field_id, created_by)
    VALUES (:tenant, :orderId, :observationId, :runId, :fieldId, :campaignFieldId, :actor)
  `, { transaction: req.dbTransaction, replacements: {
    tenant: req.tenantId, orderId,
    observationId: origin.scouting_observation_id,
    runId: origin.scouting_run_id,
    fieldId: origin.field_id,
    campaignFieldId: origin.campaign_field_id,
    actor: req.auth.user.id
  }, type: QueryTypes.INSERT });
}

export async function readObservationOrigin(req, orderId) {
  if (!(await canReadObservationOrigin(req))) return null;
  const rows = await queryTenantTransaction(`
    SELECT scouting_observation_id, scouting_run_id
    FROM work_order_observation_origins
    WHERE tenant_id = :tenant AND work_order_id = :orderId
  `, { transaction: req.dbTransaction,
    replacements: { tenant: req.tenantId, orderId },
    type: QueryTypes.SELECT });
  if (rows.length > 1) throw new HttpError(409, 'Origen de orden no verificable.',
    undefined, 'ORDER_ORIGIN_DUPLICATE');
  // The explicit key name allows the frontend to distinguish a verified
  // server-bound relation from legacy free text.
  return rows[0] ? {
    scouting_observation_id: rows[0].scouting_observation_id,
    scouting_run_id: rows[0].scouting_run_id
  } : null;
}

export function withObservationOrigin(order, origin) {
  const data = typeof order?.toJSON === 'function' ? order.toJSON() : order;
  return origin ? { ...data, observation_origin: origin } : data;
}
