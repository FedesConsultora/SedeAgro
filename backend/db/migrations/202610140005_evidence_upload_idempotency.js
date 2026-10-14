// New uploads may use a stable client UUID to make interrupted uploads retry-safe.
// Existing evidence rows retain nullable identifiers and are left untouched.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE evidence_assets
      ADD COLUMN client_upload_id uuid,
      ADD COLUMN content_sha256 varchar(64);
    CREATE UNIQUE INDEX idx_evidence_tenant_actor_upload
      ON evidence_assets (tenant_id, uploaded_by, client_upload_id)
      WHERE client_upload_id IS NOT NULL;
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP INDEX IF EXISTS idx_evidence_tenant_actor_upload;
    ALTER TABLE evidence_assets DROP COLUMN IF EXISTS content_sha256;
    ALTER TABLE evidence_assets DROP COLUMN IF EXISTS client_upload_id;
  `);
}
