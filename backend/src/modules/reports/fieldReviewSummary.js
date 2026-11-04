// Tenant-scoped operational review summary for the field report.
// These counts describe persisted execution declarations (not physical proof).
// Do not emit private review reasons, checklists, evidence, GPS or member IDs.
import { QueryTypes } from 'sequelize';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';

export const FIELD_REVIEW_RECENT_LIMIT = 5;
const STATUS_CODES = Object.freeze(['submitted', 'verified', 'rejected']);

export async function loadFieldReviewSummary(req, fieldId) {
  const parameters = { tenant: req.tenantId, field: fieldId };
  const counts = await queryTenantTransaction(`
    SELECT execution.review_status, count(*)::integer AS total
    FROM work_order_executions AS execution
    INNER JOIN work_orders AS orders
      ON orders.tenant_id = execution.tenant_id
     AND orders.id = execution.work_order_id
    WHERE execution.tenant_id = :tenant AND orders.field_id = :field
    GROUP BY execution.review_status
  `, {
    transaction: req.dbTransaction, type: QueryTypes.SELECT,
    replacements: parameters
  });
  const summary = { submitted: 0, verified: 0, rejected: 0 };
  for (const row of counts) {
    if (!STATUS_CODES.includes(row.review_status) ||
        !Number.isSafeInteger(row.total) || row.total < 0) {
      throw new Error('Invalid review summary returned by tenant database.');
    }
    summary[row.review_status] = row.total;
  }
  const pending = await queryTenantTransaction(`
    SELECT execution.id AS execution_id, execution.work_order_id,
           orders.field_id, orders.title, execution.finished_at
    FROM work_order_executions AS execution
    INNER JOIN work_orders AS orders
      ON orders.tenant_id = execution.tenant_id
     AND orders.id = execution.work_order_id
    WHERE execution.tenant_id = :tenant AND orders.field_id = :field
      AND execution.review_status = 'submitted'
    ORDER BY execution.finished_at DESC, execution.id DESC
    LIMIT :limit
  `, {
    transaction: req.dbTransaction, type: QueryTypes.SELECT,
    replacements: { ...parameters, limit: FIELD_REVIEW_RECENT_LIMIT }
  });
  return { ...summary, recentPending: pending };
}
