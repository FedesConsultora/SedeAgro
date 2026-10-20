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

// The two boundary groups can be proved without evaluating the full CASE
// projection for every candidate before LIMIT.  The UNIQUE partial index
// ux_work_execution_one_active admits at most one submitted/verified report
// per (tenant_id, work_order_id).  Even without that invariant, existence of
// ANY verified report has precedence over submitted in the legacy CASE.
// A rejected report is deliberately not an active report: it still counts as
// "no_report", matching reviewQueueStateSql's LATERAL filter.
export function reviewQueueFilterPredicateSql(reviewerId, reviewState, tenantId = null) {
  if (typeof reviewerId !== 'string' || !UUID.test(reviewerId) ||
      !Object.hasOwn(REVIEW_QUEUE_STATE_GROUPS, reviewState) ||
      reviewState === 'all') {
    throw new Error('Authenticated reviewer UUID and non-all review state required');
  }
  const related = (condition) => `EXISTS (
    SELECT 1 FROM work_order_executions r
    WHERE r.tenant_id = "WorkOrder".tenant_id
      AND r.work_order_id = "WorkOrder".id
      AND ${condition}
  )`;
  if (reviewState === 'no_report') {
    return 'NOT ' + related("r.review_status IN ('submitted', 'verified')");
  }
  if (reviewState === 'closure') {
    return related("r.review_status = 'verified'");
  }
  // Multi-row set classification is only enabled with an authenticated UUID.
  // Keep all candidate relations tenant-scoped even though FORCE RLS applies.
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw new Error('Authenticated tenant UUID required for review-state SQL');
  }
  const tenant = "'" + tenantId.toLowerCase() + "'::uuid";
  const reviewer = "'" + reviewerId.toLowerCase() + "'::uuid";
  // The partial unique index ux_work_execution_one_active guarantees a single
  // submitted OR verified row per tenant/order. This branch only needs the
  // submitted row; verified and absent reports belong to other state groups.
  // SQL aggregate tables are built ONCE for this tenant, rather than via
  // nested correlated LATERAL reads for each candidate before LIMIT.
  const states = REVIEW_QUEUE_STATE_GROUPS[reviewState];
  return `"WorkOrder".id IN (
    SELECT orders.id
    FROM work_orders orders
    JOIN work_order_executions report
      ON report.tenant_id = orders.tenant_id
      AND report.work_order_id = orders.id
      AND report.review_status = 'submitted'
    LEFT JOIN (
      SELECT wi.work_order_id, COUNT(*)::integer AS item_count
      FROM work_order_inputs wi
      WHERE wi.tenant_id = ${tenant}
      GROUP BY wi.work_order_id
    ) planned ON planned.work_order_id = orders.id
    LEFT JOIN (
      SELECT ex.work_order_execution_id,
        BOOL_OR(ex.review_status = 'rejected') AS has_rejected,
        BOOL_OR(ex.review_status <> 'approved') AS has_pending
      FROM work_order_execution_exceptions ex
      WHERE ex.tenant_id = ${tenant}
      GROUP BY ex.work_order_execution_id
    ) exceptional ON exceptional.work_order_execution_id = report.id
    LEFT JOIN (
      SELECT ev.work_order_execution_id, TRUE AS has_evidence
      FROM evidence_assets ev
      WHERE ev.tenant_id = ${tenant}
        AND ev.work_order_execution_id IS NOT NULL
      GROUP BY ev.work_order_execution_id
    ) evidence ON evidence.work_order_execution_id = report.id
    WHERE orders.tenant_id = ${tenant} AND orders.status = 'in_progress'
      AND CASE
        WHEN report.submitted_by = ${reviewer} THEN 'self_authored'
        WHEN COALESCE(planned.item_count, 0) > 0
          AND COALESCE(CASE
            WHEN jsonb_typeof(report.input_declaration->'items') = 'array'
            THEN jsonb_array_length(report.input_declaration->'items')
            END, -1) <> planned.item_count THEN 'awaiting_inputs'
        WHEN COALESCE(exceptional.has_rejected, FALSE) THEN 'rejected_exception'
        WHEN COALESCE(exceptional.has_pending, FALSE) THEN 'pending_exception'
        WHEN orders.type IN ('application', 'fertilization')
          AND NOT COALESCE(evidence.has_evidence, FALSE) THEN 'awaiting_evidence'
        ELSE 'human_review'
      END IN (${states.map(value => "'" + value + "'").join(', ')})
  )`;
}
