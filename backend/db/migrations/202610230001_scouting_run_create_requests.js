// 0U.20 — durable creation receipt independent of scouting_run lifetime.
// The source run can disappear; the request key must never be silently reused.
// No historical scouting row is changed. Only scoped, audited server code writes.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE scouting_run_create_requests (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      requested_by uuid NOT NULL,
      client_request_id uuid NOT NULL,
      request_hash varchar(64) NOT NULL
        CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      run_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, requested_by, client_request_id),
      CONSTRAINT scouting_create_run_same_tenant_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES scouting_runs (tenant_id, id)
        ON DELETE SET NULL (run_id)
    );
    CREATE INDEX idx_scouting_create_receipt_run
      ON scouting_run_create_requests (tenant_id, run_id)
      WHERE run_id IS NOT NULL;
    ALTER TABLE scouting_run_create_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE scouting_run_create_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY scouting_create_receipt_read
      ON scouting_run_create_requests FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY scouting_create_receipt_insert
      ON scouting_run_create_requests FOR INSERT
      WITH CHECK (tenant_id = app.current_tenant_id());
    CREATE POLICY scouting_create_receipt_update
      ON scouting_run_create_requests FOR UPDATE
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
    -- Deliberately no runtime DELETE policy: keys survive run deletion.
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM scouting_run_create_requests) THEN
        RAISE EXCEPTION 'Refusing to erase scouting creation idempotency receipts';
      END IF;
    END $$;
    DROP TABLE scouting_run_create_requests;
  `);
}
