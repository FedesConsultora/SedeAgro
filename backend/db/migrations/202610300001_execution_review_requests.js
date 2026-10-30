// The UUID receipt and the independently reviewed report/audit MUST commit
// in one tenant-scoped transaction. Existing legacy reviews remain unchanged.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE work_order_execution_review_requests (
      tenant_id uuid NOT NULL,
      reviewed_by uuid NOT NULL,
      client_request_id uuid NOT NULL,
      work_order_id uuid NOT NULL,
      execution_id uuid NOT NULL,
      request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, reviewed_by, client_request_id),
      CONSTRAINT execution_review_receipt_reviewer_fk FOREIGN KEY (tenant_id, reviewed_by)
        REFERENCES memberships(tenant_id, user_id),
      CONSTRAINT execution_review_receipt_order_fk FOREIGN KEY (tenant_id, work_order_id)
        REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT execution_review_receipt_execution_fk FOREIGN KEY (tenant_id, execution_id)
        REFERENCES work_order_executions(tenant_id, id) ON DELETE CASCADE
    );
    ALTER TABLE work_order_execution_review_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE work_order_execution_review_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY execution_review_receipts_tenant_isolation
      ON work_order_execution_review_requests
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_execution_review_requests LIMIT 1) THEN
        RAISE EXCEPTION 'Cannot drop durable execution review receipts with recorded decisions';
      END IF;
    END $$;
    DROP TABLE work_order_execution_review_requests;
  `);
}
