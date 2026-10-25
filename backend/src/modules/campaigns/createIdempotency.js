import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Campaign } from '../../models/index.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { HttpError } from '../../utils/http.js';

// Called after Zod has coerced dates and supplied its default status.
export function campaignCreateFingerprint(input) {
  const canonical = {
    name: input.name,
    season_year: input.season_year,
    starts_at: input.starts_at instanceof Date ? input.starts_at.toISOString().slice(0, 10) : input.starts_at,
    ends_at: input.ends_at instanceof Date ? input.ends_at.toISOString().slice(0, 10) : input.ends_at ?? null,
    status: input.status
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function reserveCampaignCreate(req, input) {
  if (!input.client_request_id) return { kind: 'legacy' };
  const replacements = {
    tenant: req.tenantId,
    actor: req.auth.user.id,
    key: input.client_request_id,
    hash: campaignCreateFingerprint(input)
  };
  // UNIQUE receipt primary key serializes concurrent attempts across workers.
  // The loser waits on the winning transaction and then reads its committed
  // receipt. A failure before COMMIT rolls back both receipt and campaign.
  const [inserted] = await queryTenantTransaction(`
    INSERT INTO campaign_create_requests
      (tenant_id, requested_by, client_request_id, request_hash)
    VALUES (:tenant, :actor, :key, :hash)
    ON CONFLICT (tenant_id, requested_by, client_request_id) DO NOTHING
    RETURNING client_request_id
  `, {
    transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT
  });
  if (inserted) return { kind: 'new', replacements };
  const [receipt] = await queryTenantTransaction(`
    SELECT request_hash, campaign_id FROM campaign_create_requests
    WHERE tenant_id = :tenant AND requested_by = :actor AND client_request_id = :key
  `, {
    transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT
  });
  if (!receipt) {
    throw new HttpError(409, 'No se pudo verificar el acuse anterior de campaña.',
      undefined, 'CAMPAIGN_CREATE_RECEIPT_UNAVAILABLE');
  }
  if (receipt.request_hash !== replacements.hash) {
    throw new HttpError(409, 'Esta clave ya fue usada con otra campaña.',
      undefined, 'CAMPAIGN_CREATE_REQUEST_CONFLICT');
  }
  if (!receipt.campaign_id) {
    throw new HttpError(409, 'La campaña original ya no está disponible.',
      undefined, 'CAMPAIGN_CREATE_RESULT_GONE');
  }
  const campaign = await Campaign.findOne({
    where: { id: receipt.campaign_id, tenant_id: req.tenantId },
    transaction: req.dbTransaction
  });
  if (!campaign) {
    throw new HttpError(409, 'La campaña original ya no está disponible.',
      undefined, 'CAMPAIGN_CREATE_RESULT_GONE');
  }
  return { kind: 'replay', campaign };
}

export async function completeCampaignCreate(req, reservation, campaignId) {
  if (reservation.kind !== 'new') return;
  const [saved] = await queryTenantTransaction(`
    UPDATE campaign_create_requests SET campaign_id = :campaign
    WHERE tenant_id = :tenant AND requested_by = :actor
      AND client_request_id = :key AND request_hash = :hash
      AND campaign_id IS NULL
    RETURNING campaign_id
  `, {
    transaction: req.dbTransaction, type: QueryTypes.SELECT,
    replacements: { ...reservation.replacements, campaign: campaignId }
  });
  if (saved?.campaign_id !== campaignId) {
    throw new HttpError(500, 'No se pudo confirmar la identidad de campaña.');
  }
}
