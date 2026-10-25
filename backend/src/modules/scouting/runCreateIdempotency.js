// Durable, actor-scoped receipt for POST /scouting/runs.
// The stable UUID is not a session token. Current server RBAC still gates every
// replay; a matching key alone never authorizes read or creation.
import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { ScoutingRun } from '../../models/index.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { HttpError } from '../../utils/http.js';

export function scoutingRunCreateFingerprint(input) {
  // Zod has already parsed the request and supplied default status. Optional
  // nulls are semantically equivalent to omitted fields; date offsets aren't.
  const canonical = {
    campaign_field_id: input.campaign_field_id,
    assigned_to: input.assigned_to ?? null,
    scheduled_at: input.scheduled_at?.toISOString() ?? null,
    status: input.status,
    summary: input.summary ?? null
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function reserveScoutingRunCreate(req, input) {
  if (!input.client_request_id) return { kind: 'legacy' };
  const replacements = {
    tenant: req.tenantId,
    actor: req.auth.user.id,
    key: input.client_request_id,
    hash: scoutingRunCreateFingerprint(input)
  };
  // The unique PRIMARY KEY serializes simultaneous HTTP requests, including
  // independent workers. The losing INSERT waits for the winning transaction
  // and can then read its committed receipt in this READ COMMITTED transaction.
  const [inserted] = await queryTenantTransaction(`
    INSERT INTO scouting_run_create_requests
      (tenant_id, requested_by, client_request_id, request_hash)
    VALUES (:tenant, :actor, :key, :hash)
    ON CONFLICT (tenant_id, requested_by, client_request_id) DO NOTHING
    RETURNING client_request_id
  `, {
    transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT
  });
  if (inserted) return { kind: 'new', replacements };
  const [receipt] = await queryTenantTransaction(`
    SELECT request_hash, run_id
    FROM scouting_run_create_requests
    WHERE tenant_id = :tenant AND requested_by = :actor AND client_request_id = :key
  `, {
    transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT
  });
  if (!receipt) {
    throw new HttpError(409, 'No se pudo verificar el acuse anterior de la recorrida.',
      undefined, 'SCOUTING_CREATE_RECEIPT_UNAVAILABLE');
  }
  if (receipt.request_hash !== replacements.hash) {
    throw new HttpError(409, 'Esta clave de creación ya fue usada con otra recorrida.',
      undefined, 'SCOUTING_CREATE_REQUEST_CONFLICT');
  }
  // ON DELETE SET NULL deliberately preserves a tombstone after deleting the
  // original run. A stale replay must not create a different run under that ID.
  if (!receipt.run_id) {
    throw new HttpError(409, 'La recorrida original ya no está disponible.',
      undefined, 'SCOUTING_CREATE_RESULT_GONE');
  }
  const run = await ScoutingRun.findOne({
    where: { tenant_id: req.tenantId, id: receipt.run_id },
    transaction: req.dbTransaction
  });
  if (!run) {
    throw new HttpError(409, 'La recorrida original ya no está disponible.',
      undefined, 'SCOUTING_CREATE_RESULT_GONE');
  }
  return { kind: 'replay', run };
}

export async function completeScoutingRunCreate(req, reservation, runId) {
  if (reservation.kind !== 'new') return;
  const [saved] = await queryTenantTransaction(`
    UPDATE scouting_run_create_requests SET run_id = :run
    WHERE tenant_id = :tenant AND requested_by = :actor
      AND client_request_id = :key AND request_hash = :hash
      AND run_id IS NULL
    RETURNING run_id
  `, {
    transaction: req.dbTransaction,
    type: QueryTypes.SELECT,
    replacements: { ...reservation.replacements, run: runId }
  });
  if (saved?.run_id !== runId) {
    throw new HttpError(500, 'No se pudo confirmar la identidad de la recorrida.');
  }
}
