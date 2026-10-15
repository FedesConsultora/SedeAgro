// 0T.7: bounded, tenant-RLS job state plus immutable private file payload.
// Dedicated worker connects as the same least-privilege application DB role.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE report_runs
      ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
      ADD COLUMN lease_token uuid,
      ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN next_attempt_at timestamptz,
      ADD COLUMN error_code varchar(64),
      ADD CONSTRAINT report_runs_lease_pair CHECK
        ((lease_token IS NULL AND lease_expires_at IS NULL) OR
         (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL));
    CREATE INDEX idx_report_runs_claim ON report_runs(tenant_id, status, next_attempt_at, created_at)
      WHERE status IN ('queued', 'running');

    CREATE TABLE report_run_files (
      run_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      format varchar(8) NOT NULL CHECK (format IN ('pdf', 'xlsx', 'csv')),
      mime_type varchar(120) NOT NULL,
      content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 3145728),
      sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, run_id),
      CONSTRAINT report_run_files_same_tenant_fk
        FOREIGN KEY (tenant_id, run_id) REFERENCES report_runs(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_report_run_files_expiry ON report_run_files(tenant_id, expires_at);
    ALTER TABLE report_run_files ENABLE ROW LEVEL SECURITY;
    ALTER TABLE report_run_files FORCE ROW LEVEL SECURITY;
    CREATE POLICY report_run_files_tenant_isolation ON report_run_files
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP TABLE IF EXISTS report_run_files;
    DROP INDEX IF EXISTS idx_report_runs_claim;
    ALTER TABLE report_runs
      DROP CONSTRAINT IF EXISTS report_runs_lease_pair,
      DROP COLUMN IF EXISTS error_code,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS lease_expires_at,
      DROP COLUMN IF EXISTS lease_token,
      DROP COLUMN IF EXISTS attempt_count;
  `);
}
