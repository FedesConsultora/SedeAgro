import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { CampaignField } from '../../models/index.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { HttpError } from '../../utils/http.js';

// Fingerprint of parsed Zod values, not user-supplied JSON field order.
// Preserve the campaign identity: one key cannot silently reparent a field.
export function campaignFieldAssignFingerprint(campaignId, input) {
  const date = value => value == null ? null :
    value instanceof Date ? value.toISOString().slice(0, 10) : value;
  const canonical = {
    campaign_id: campaignId,
    field_id: input.field_id,
    crop_type_id: input.crop_type_id,
    crop_variety_id: input.crop_variety_id ?? null,
    planting_date: date(input.planting_date),
    harvest_target_date: date(input.harvest_target_date),
    expected_yield: input.expected_yield == null ? null : Number(input.expected_yield).toFixed(2),
    status: input.status
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function reserveCampaignFieldAssign(req, campaignId, input) {
  if (!input.client_request_id) return { kind: 'legacy' };
  const replacements = {
    tenant: req.tenantId, actor: req.auth.user.id, key: input.client_request_id,
    hash: campaignFieldAssignFingerprint(campaignId, input)
  };
  // A unique primary key serializes simultaneous requests across processes.
  // The original field and receipt are committed/rolled back atomically in
  // the same transaction. The losing INSERT waits for the original result.
  const [inserted] = await queryTenantTransaction(`
    INSERT INTO campaign_field_assign_requests
      (tenant_id, requested_by, client_request_id, request_hash)
    VALUES (:tenant, :actor, :key, :hash)
    ON CONFLICT (tenant_id, requested_by, client_request_id) DO NOTHING
    RETURNING client_request_id
  `, { transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT });
  if (inserted) return { kind: 'new', replacements };
  const [receipt] = await queryTenantTransaction(`
    SELECT request_hash, campaign_field_id FROM campaign_field_assign_requests
    WHERE tenant_id = :tenant AND requested_by = :actor AND client_request_id = :key
  `, { transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT });
  if (!receipt) {
    throw new HttpError(409, 'No se pudo verificar el acuse anterior de lote.',
      undefined, 'CAMPAIGN_FIELD_RECEIPT_UNAVAILABLE');
  }
  if (receipt.request_hash !== replacements.hash) {
    throw new HttpError(409, 'Esta clave ya fue usada para otra asignación.',
      undefined, 'CAMPAIGN_FIELD_REQUEST_CONFLICT');
  }
  if (!receipt.campaign_field_id) {
    throw new HttpError(409, 'La asignación original ya no está disponible.',
      undefined, 'CAMPAIGN_FIELD_RESULT_GONE');
  }
  const campaignField = await CampaignField.findOne({
    where: { tenant_id: req.tenantId, id: receipt.campaign_field_id,
      campaign_id: campaignId },
    transaction: req.dbTransaction
  });
  if (!campaignField) {
    throw new HttpError(409, 'La asignación original ya no está disponible.',
      undefined, 'CAMPAIGN_FIELD_RESULT_GONE');
  }
  return { kind: 'replay', campaignField };
}

export async function completeCampaignFieldAssign(req, reservation, fieldId) {
  if (reservation.kind !== 'new') return;
  const [saved] = await queryTenantTransaction(`
    UPDATE campaign_field_assign_requests SET campaign_field_id = :field
    WHERE tenant_id = :tenant AND requested_by = :actor
      AND client_request_id = :key AND request_hash = :hash
      AND campaign_field_id IS NULL
    RETURNING campaign_field_id
  `, {
    transaction: req.dbTransaction, type: QueryTypes.SELECT,
    replacements: { ...reservation.replacements, field: fieldId }
  });
  if (saved?.campaign_field_id !== fieldId) {
    throw new HttpError(500, 'No se pudo confirmar la identidad de asignación.');
  }
}
