export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE auth_sessions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_auth_sessions_user_tenant
      ON auth_sessions (tenant_id, user_id, expires_at DESC);
    CREATE INDEX idx_auth_sessions_expiry
      ON auth_sessions (expires_at) WHERE revoked_at IS NULL;
    ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY auth_sessions_tenant_policy ON auth_sessions
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query('DROP TABLE IF EXISTS auth_sessions;');
}
