// Read-only SQL projection matching classifyReviewQueueItem, evaluated before
// keyset LIMIT. All private child tables remain behind the transaction's RLS.
export const REVIEW_QUEUE_STATE_GROUPS = Object.freeze({
  all: Object.freeze(null),
  no_report: Object.freeze(['awaiting_report']),
  blocked: Object.freeze([
    'self_authored', 'awaiting_inputs', 'rejected_exception',
    'pending_exception', 'awaiting_evidence'
  ]),
  review: Object.freeze(['human_review']),
  closure: Object.freeze(['ready_for_closure'])
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function reviewQueueStateSql(reviewerId) {
  // UUID-only insertion; no untrusted SQL identifier, expression or value.
  if (typeof reviewerId !== 'string' || !UUID.test(reviewerId)) {
    throw new Error('Authenticated reviewer UUID required for review-state SQL');
  }
  const reviewer = "'" + reviewerId.toLowerCase() + "'::uuid";
  return `(
    SELECT CASE
      WHEN latest.id IS NULL THEN 'awaiting_report'
      WHEN latest.review_status = 'verified' THEN 'ready_for_closure'
      WHEN latest.submitted_by = ${reviewer} THEN 'self_authored'
      WHEN planned.item_count > 0
        AND COALESCE(CASE WHEN jsonb_typeof(latest.input_declaration->'items') = 'array'
          THEN jsonb_array_length(latest.input_declaration->'items')
          END, -1) <> planned.item_count THEN 'awaiting_inputs'
      WHEN EXISTS (
        SELECT 1 FROM work_order_execution_exceptions ex
        WHERE ex.tenant_id = "WorkOrder".tenant_id
          AND ex.work_order_execution_id = latest.id AND ex.review_status = 'rejected'
      ) THEN 'rejected_exception'
      WHEN EXISTS (
        SELECT 1 FROM work_order_execution_exceptions ex
        WHERE ex.tenant_id = "WorkOrder".tenant_id
          AND ex.work_order_execution_id = latest.id AND ex.review_status <> 'approved'
      ) THEN 'pending_exception'
      WHEN "WorkOrder".type IN ('application', 'fertilization') AND NOT EXISTS (
        SELECT 1 FROM evidence_assets ev
        WHERE ev.tenant_id = "WorkOrder".tenant_id
          AND ev.work_order_execution_id = latest.id
      ) THEN 'awaiting_evidence'
      ELSE 'human_review'
    END
    FROM (SELECT 1) singleton
    LEFT JOIN LATERAL (
      SELECT r.id, r.review_status, r.submitted_by, r.input_declaration
      FROM work_order_executions r
      WHERE r.tenant_id = "WorkOrder".tenant_id
        AND r.work_order_id = "WorkOrder".id
        AND r.review_status IN ('submitted', 'verified')
      ORDER BY (r.review_status = 'verified') DESC, r.created_at DESC, r.id DESC
      LIMIT 1
    ) latest ON TRUE
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::integer AS item_count FROM work_order_inputs wi
      WHERE wi.tenant_id = "WorkOrder".tenant_id
        AND wi.work_order_id = "WorkOrder".id
    ) planned
  )`;
}
