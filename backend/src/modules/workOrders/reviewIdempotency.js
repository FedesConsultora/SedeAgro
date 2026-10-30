import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { HttpError } from '../../utils/http.js';

// Canonical payload *after* Zod validation. Never fingerprint a client-supplied
// tenant/reviewer. A key can identify exactly one order+report+decision+body.
export function reviewRequestFingerprint({ orderId, executionId, input }) {
  const checklist = input.decision === 'verified'
    ? {
        time_checked: input.checklist.time_checked,
        area_checked: input.checklist.area_checked,
        result_checked: input.checklist.result_checked,
        operation_checked: input.checklist.operation_checked,
        evidence_basis: input.checklist.evidence_basis
      }
    : null;
  return createHash('sha256').update(JSON.stringify({
    order_id: orderId,
    execution_id: executionId,
    decision: input.decision,
    reason: input.decision === 'rejected' ? input.reason : null,
    checklist
  })).digest('hex');
}

export async function reserveExecutionReview(req, report) {
  const input = req.body;
  if (!input.client_request_id) return { kind: 'legacy' };
  const replacements = {
    tenant: req.tenantId,
    actor: req.auth.user.id,
    key: input.client_request_id,
    order: report.work_order_id,
    execution: report.id,
    hash: reviewRequestFingerprint({
      orderId: report.work_order_id, executionId: report.id, input
    })
  };
  // PostgreSQL unique key serializes multiple processes (and repeated
  // requests from different tabs). RLS still isolates tenant access.
  const [inserted] = await queryTenantTransaction(`
    INSERT INTO work_order_execution_review_requests
      (tenant_id, reviewed_by, client_request_id, work_order_id, execution_id, request_hash)
    VALUES (:tenant, :actor, :key, :order, :execution, :hash)
    ON CONFLICT (tenant_id, reviewed_by, client_request_id) DO NOTHING
    RETURNING client_request_id
  `, { transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT });
  if (inserted) return { kind: 'new' };

  const [receipt] = await queryTenantTransaction(`
    SELECT work_order_id, execution_id, request_hash
    FROM work_order_execution_review_requests
    WHERE tenant_id=:tenant AND reviewed_by=:actor AND client_request_id=:key
  `, { transaction: req.dbTransaction, replacements, type: QueryTypes.SELECT });
  if (!receipt) throw new HttpError(409,
    'No se puede comprobar el recibo previo de la revisión.', undefined,
    'EXECUTION_REVIEW_RECEIPT_UNAVAILABLE');
  if (receipt.work_order_id !== replacements.order ||
      receipt.execution_id !== replacements.execution ||
      receipt.request_hash !== replacements.hash) {
    throw new HttpError(409,
      'La clave de revisión ya fue utilizada con otra decisión o parte.', undefined,
      'EXECUTION_REVIEW_REQUEST_CONFLICT');
  }
  if (report.reviewed_by !== req.auth.user.id ||
      report.review_status !== input.decision ||
      !report.reviewed_at) {
    throw new HttpError(409,
      'El recibo de revisión no coincide con el estado persistido.', undefined,
      'EXECUTION_REVIEW_RECEIPT_MISMATCH');
  }
  return { kind: 'replay' };
}
