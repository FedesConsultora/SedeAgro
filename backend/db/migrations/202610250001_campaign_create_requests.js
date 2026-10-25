// Actor-scoped persistent receipt for an optional campaign creation UUID.
// Same-tenant read is not proof of authorization; RBAC precedes every replay.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE campaign_create_requests (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      requested_by uuid NOT NULL,
      client_request_id uuid NOT NULL,
      request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      campaign_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, requested_by, client_request_id),
      CONSTRAINT campaign_create_same_tenant_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE SET NULL (campaign_id)
    );
    CREATE INDEX idx_campaign_create_receipt_campaign
      ON campaign_create_requests (tenant_id, campaign_id)
      WHERE campaign_id IS NOT NULL;
    ALTER TABLE campaign_create_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_create_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY campaign_create_receipt_read ON campaign_create_requests FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY campaign_create_receipt_insert ON campaign_create_requests FOR INSERT
      WITH CHECK (tenant_id = app.current_tenant_id());
    CREATE POLICY campaign_create_receipt_update ON campaign_create_requests FOR UPDATE
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
    -- No runtime DELETE policy: a deleted campaign leaves a tombstone.
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM campaign_create_requests) THEN
        RAISE EXCEPTION 'Refusing to erase persisted campaign creation receipts';
      END IF;
    END $$;
    DROP TABLE campaign_create_requests;
  `);
}
