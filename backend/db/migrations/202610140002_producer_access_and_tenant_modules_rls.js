// Explicit, revocable producer visibility grants. Do not infer access from
// matching emails, names, contacts or mere membership in the tenant.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE producer_access_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      producer_id uuid NOT NULL,
      granted_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, user_id, producer_id),
      CONSTRAINT producer_grant_member_same_tenant_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE,
      CONSTRAINT producer_grant_producer_same_tenant_fk
        FOREIGN KEY (tenant_id, producer_id) REFERENCES producers(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT producer_grant_actor_same_tenant_fk
        FOREIGN KEY (tenant_id, granted_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (granted_by)
    );
    CREATE INDEX idx_producer_grants_user ON producer_access_grants (tenant_id, user_id, producer_id);
    ALTER TABLE producer_access_grants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE producer_access_grants FORCE ROW LEVEL SECURITY;
    CREATE POLICY producer_access_grants_tenant_isolation ON producer_access_grants
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());

    -- Login and registration have explicit tenant-local transactions, and the
    -- platform administration router temporarily switches the transaction's GUC.
    ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_modules FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_modules_tenant_isolation ON tenant_modules
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP POLICY IF EXISTS tenant_modules_tenant_isolation ON tenant_modules;
    ALTER TABLE tenant_modules NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE tenant_modules DISABLE ROW LEVEL SECURITY;
    DROP TABLE IF EXISTS producer_access_grants;
  `);
}
