const scopedTables = [
  'teams',
  'team_members',
  'machinery',
  'agricultural_inputs',
  'work_order_inputs',
  'work_order_machinery',
  'satellite_layers',
  'report_templates',
  'report_runs',
  'sync_batches',
  'sync_operations',
  'notifications'
];

export async function up({ context: queryInterface }) {
  for (const table of scopedTables) {
    await queryInterface.sequelize.query(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
      CREATE POLICY ${table}_tenant_isolation
        ON ${table}
        USING (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id());
    `);
  }
}

export async function down({ context: queryInterface }) {
  for (const table of scopedTables) {
    await queryInterface.sequelize.query(`
      DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
      ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
    `);
  }
}
