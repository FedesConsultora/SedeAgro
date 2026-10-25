import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { WorkOrder } from '../../models/index.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { HttpError } from '../../utils/http.js';

export function workOrderCreateFingerprint(input) {
  // Canonical authored values after Zod coercions/defaults.
  const canonical = {
    campaign_field_id: input.campaign_field_id ?? null,
    field_id: input.field_id,
    type: input.type,
    priority: input.priority,
    due_at: input.due_at instanceof Date ? input.due_at.toISOString() : input.due_at ?? null,
    title: input.title,
    instructions: input.instructions ?? null,
    status: 'draft'
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function reserveWorkOrderCreate(req, input) {
  if (!input.client_request_id) return { kind: 'legacy' };
  const replacements = {
    tenant: req.tenantId,
    actor: req.auth.user.id,
    key: input.client_request_id,
    hash: workOrderCreateFingerprint(input)
  };
  const [inserted] = await queryTenantTransaction(`
    INSERT INTO work_order_create_requests
      (tenant_id, requested_by, client_request_id, request_hash)
    VALUES (:tenant, :actor, :key, :hash)
    ON CONFLICT (tenant_id, requested_by, client_request_id) DO NOTHING
    RETURNING client_request_id
  `, { transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT });
  if (inserted) return { kind: 'new', replacements };
  const [receipt] = await queryTenantTransaction(`
    SELECT request_hash, work_order_id FROM work_order_create_requests
    WHERE tenant_id = :tenant AND requested_by = :actor AND client_request_id = :key
  `, { transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT });
  if (!receipt) {
    throw new HttpError(409, 'No se pudo verificar el acuse anterior de orden de trabajo.',
      undefined, 'WORK_ORDER_CREATE_RECEIPT_UNAVAILABLE');
  }
  if (receipt.request_hash !== replacements.hash) {
    throw new HttpError(409, 'La clave ya fue utilizada con otra orden de trabajo.',
      undefined, 'WORK_ORDER_CREATE_REQUEST_CONFLICT');
  }
  if (!receipt.work_order_id) {
    throw new HttpError(409, 'La orden original ya no está disponible.',
      undefined, 'WORK_ORDER_CREATE_RESULT_GONE');
  }
  const order = await WorkOrder.findOne({
    where: { id: receipt.work_order_id, tenant_id: req.tenantId },
    transaction: req.dbTransaction
  });
  if (!order) {
    throw new HttpError(409, 'La orden original ya no está disponible.',
      undefined, 'WORK_ORDER_CREATE_RESULT_GONE');
  }
  return { kind: 'replay', order };
}

export async function completeWorkOrderCreate(req, reservation, orderId) {
  if (reservation.kind !== 'new') return;
  const [saved] = await queryTenantTransaction(`
    UPDATE work_order_create_requests SET work_order_id = :order
    WHERE tenant_id = :tenant AND requested_by = :actor
      AND client_request_id = :key AND request_hash = :hash
      AND work_order_id IS NULL
    RETURNING work_order_id
  `, {
    transaction: req.dbTransaction, type: QueryTypes.SELECT,
    replacements: { ...reservation.replacements, order: orderId }
  });
  if (saved?.work_order_id !== orderId) {
    throw new HttpError(500, 'No se pudo confirmar la orden de trabajo.');
  }
}
