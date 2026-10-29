// Members are strictly tenant-local even for the table owner. Public login
// discovers eligible memberships using bounded tenant-local transactions,
// NEVER an unrestricted memberships SELECT, SECURITY DEFINER or BYPASSRLS.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS memberships_tenant_isolation ON memberships;
    CREATE POLICY memberships_tenant_isolation ON memberships
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

// Explicit administrative rollback only. Disables a critical security
// boundary: never run on staging/production without security-owner approval.
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP POLICY IF EXISTS memberships_tenant_isolation ON memberships;
    ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE memberships DISABLE ROW LEVEL SECURITY;
  `);
}
