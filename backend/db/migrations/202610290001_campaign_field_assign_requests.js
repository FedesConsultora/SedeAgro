// Durable ACK for a field assigned to a campaign. A request UUID is never an
// authorization token: RBAC and tenant RLS must run before any replay lookup.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE campaign_field_assign_requests (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      requested_by uuid NOT NULL,
      client_request_id uuid NOT NULL,
      request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      campaign_field_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, requested_by, client_request_id),
      CONSTRAINT campaign_field_assign_same_tenant_fk
        FOREIGN KEY (tenant_id, campaign_field_id)
        REFERENCES campaign_fields (tenant_id, id)
        ON DELETE SET NULL (campaign_field_id)
    );
    CREATE INDEX idx_campaign_field_assign_receipt
      ON campaign_field_assign_requests (tenant_id, campaign_field_id)
      WHERE campaign_field_id IS NOT NULL;
    ALTER TABLE campaign_field_assign_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_field_assign_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY campaign_field_assign_receipt_read ON campaign_field_assign_requests FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY campaign_field_assign_receipt_insert ON campaign_field_assign_requests FOR INSERT
      WITH CHECK (tenant_id = app.current_tenant_id());
    CREATE POLICY campaign_field_assign_receipt_update ON campaign_field_assign_requests FOR UPDATE
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
    -- No DELETE policy: deleting a campaign-field preserves a receipt tombstone.
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM campaign_field_assign_requests) THEN
        RAISE EXCEPTION 'Refusing to erase persisted campaign-field assignment receipts';
      END IF;
    END $$;
    DROP TABLE campaign_field_assign_requests;
  `);
}
