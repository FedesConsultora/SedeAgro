// Core tables containing tenant-scoped integration credentials and seat snapshots
// were created before the business RLS migrations. Protect them without changing
// the global auth membership and cross-tenant platform administration flows.
const tables = ['tenant_integrations', 'tenant_seat_usage'];

export async function up({ context: queryInterface }) {
  for (const table of tables) {
    await queryInterface.sequelize.query(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
      CREATE POLICY ${table}_tenant_isolation ON ${table}
        USING (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id());
    `);
  }
}

export async function down({ context: queryInterface }) {
  for (const table of tables) {
    await queryInterface.sequelize.query(`
      DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
      ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
    `);
  }
}
