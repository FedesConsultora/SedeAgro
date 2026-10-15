// 0T.9: immutable execution declarations with a separate, attributable review.
// No old work orders are auto-completed or assigned fictional measurements.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE work_order_executions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      work_order_id uuid NOT NULL,
      submitted_by uuid NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL,
      worked_area_hectares numeric(12,2) NOT NULL CHECK (worked_area_hectares > 0 AND worked_area_hectares <= 1000000),
      result_summary varchar(2000) NOT NULL CHECK (length(btrim(result_summary)) >= 10),
      review_status varchar(24) NOT NULL DEFAULT 'submitted'
        CHECK (review_status IN ('submitted', 'verified', 'rejected')),
      reviewed_by uuid,
      reviewed_at timestamptz,
      review_note varchar(500),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CONSTRAINT work_execution_order_tenant_fk
        FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT work_execution_submitter_tenant_fk
        FOREIGN KEY (tenant_id, submitted_by) REFERENCES memberships(tenant_id, user_id),
      CONSTRAINT work_execution_reviewer_tenant_fk
        FOREIGN KEY (tenant_id, reviewed_by) REFERENCES memberships(tenant_id, user_id),
      CONSTRAINT work_execution_time CHECK (started_at <= finished_at),
      CONSTRAINT work_execution_review_consistency CHECK (
        (review_status = 'submitted' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
        OR (review_status = 'verified' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by <> submitted_by)
        OR (review_status = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
          AND reviewed_by <> submitted_by AND review_note IS NOT NULL AND length(btrim(review_note)) >= 10)
      )
    );
    CREATE UNIQUE INDEX ux_work_execution_one_active
      ON work_order_executions(tenant_id, work_order_id)
      WHERE review_status IN ('submitted', 'verified');
    CREATE INDEX idx_work_execution_history
      ON work_order_executions(tenant_id, work_order_id, created_at DESC);
    ALTER TABLE work_order_executions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE work_order_executions FORCE ROW LEVEL SECURITY;
    CREATE POLICY work_order_executions_tenant_isolation ON work_order_executions
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

// Fail closed: reverting the schema must never silently destroy reports.
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_executions LIMIT 1) THEN
        RAISE EXCEPTION 'Cannot rollback work_order_executions while records exist; preserve/export first';
      END IF;
    END $$;
    DROP TABLE work_order_executions;
  `);
}
