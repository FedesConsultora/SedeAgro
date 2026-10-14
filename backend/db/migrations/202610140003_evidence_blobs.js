// Small evidence bytes stored atomically with evidence_assets.
// Bound to 2 MiB per file at the API; move to object storage for larger media later.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE evidence_blobs (
      evidence_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      content bytea NOT NULL CHECK (octet_length(content) > 0 AND octet_length(content) <= 2097152),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, evidence_id),
      CONSTRAINT evidence_blobs_asset_same_tenant_fk
        FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence_assets(tenant_id, id) ON DELETE CASCADE
    );

    ALTER TABLE evidence_blobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE evidence_blobs FORCE ROW LEVEL SECURITY;
    CREATE POLICY evidence_blobs_tenant_isolation ON evidence_blobs
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query('DROP TABLE IF EXISTS evidence_blobs;');
}
