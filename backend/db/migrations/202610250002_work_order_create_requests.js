// 0U — receipt for durable work-order creation; never use a request UUID as auth.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE work_order_create_requests (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      requested_by uuid NOT NULL,
      client_request_id uuid NOT NULL,
      request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      work_order_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, requested_by, client_request_id),
      CONSTRAINT work_order_create_same_tenant_fk
        FOREIGN KEY (tenant_id, work_order_id)
        REFERENCES work_orders (tenant_id, id)
        ON DELETE SET NULL (work_order_id)
    );
    CREATE INDEX idx_work_order_create_receipt_work_order
      ON work_order_create_requests (tenant_id, work_order_id)
      WHERE work_order_id IS NOT NULL;
    ALTER TABLE work_order_create_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE work_order_create_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY work_order_create_receipt_read ON work_order_create_requests FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY work_order_create_receipt_insert ON work_order_create_requests FOR INSERT
      WITH CHECK (tenant_id = app.current_tenant_id());
    CREATE POLICY work_order_create_receipt_update ON work_order_create_requests FOR UPDATE
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
    -- No runtime DELETE policy: deleted orders preserve a tombstone.
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_create_requests) THEN
        RAISE EXCEPTION 'Refusing to erase persisted work order creation receipts';
      END IF;
    END $$;
    DROP TABLE work_order_create_requests;
  `);
}
