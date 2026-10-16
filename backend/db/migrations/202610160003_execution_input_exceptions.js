// 0T.13: one immutable declaration per unplanned catalog item and report.
// Human approval does not change inventory or assert physical use.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE work_order_execution_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      work_order_id uuid NOT NULL,
      work_order_execution_id uuid NOT NULL,
      input_id uuid NOT NULL,
      client_request_id uuid NOT NULL,
      submitted_by uuid NOT NULL,
      quantity numeric(12,4) NOT NULL CHECK (quantity > 0 AND quantity <= 99999999.9999),
      input_name varchar(180) NOT NULL,
      unit varchar(40) NOT NULL,
      reason varchar(500) NOT NULL CHECK (length(btrim(reason)) >= 10),
      review_status varchar(24) NOT NULL DEFAULT 'submitted'
        CHECK (review_status IN ('submitted', 'approved', 'rejected')),
      reviewed_by uuid,
      reviewed_at timestamptz,
      review_note varchar(500),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT execution_exception_report_scope_fk
        FOREIGN KEY (tenant_id, work_order_id, work_order_execution_id)
        REFERENCES work_order_executions(tenant_id, work_order_id, id) ON DELETE CASCADE,
      CONSTRAINT execution_exception_catalog_scope_fk
        FOREIGN KEY (tenant_id, input_id) REFERENCES agricultural_inputs(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT execution_exception_submitter_scope_fk
        FOREIGN KEY (tenant_id, submitted_by) REFERENCES memberships(tenant_id, user_id),
      CONSTRAINT execution_exception_reviewer_scope_fk
        FOREIGN KEY (tenant_id, reviewed_by) REFERENCES memberships(tenant_id, user_id),
      CONSTRAINT execution_exception_review_consistency CHECK (
        (review_status = 'submitted' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
        OR (review_status = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
          AND reviewed_by <> submitted_by AND review_note IS NULL)
        OR (review_status = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
          AND reviewed_by <> submitted_by AND review_note IS NOT NULL AND length(btrim(review_note)) >= 10)
      ),
      UNIQUE (tenant_id, work_order_execution_id, input_id),
      UNIQUE (tenant_id, submitted_by, client_request_id)
    );
    CREATE INDEX idx_execution_exceptions_history
      ON work_order_execution_exceptions(tenant_id, work_order_id, work_order_execution_id, created_at, id);
    ALTER TABLE work_order_execution_exceptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE work_order_execution_exceptions FORCE ROW LEVEL SECURITY;
    CREATE POLICY execution_exceptions_tenant_isolation ON work_order_execution_exceptions
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_execution_exceptions LIMIT 1) THEN
        RAISE EXCEPTION 'Cannot rollback execution exceptions while records exist; preserve/export first';
      END IF;
    END $$;
    DROP TABLE work_order_execution_exceptions;
  `);
}
