// 0S.15 — Two small additive indexes for the run-scoped keyset reader.
// This does not modify RLS policies, privacy, blob contents or the query API.
// Use an explicit rollback; indexes are named uniquely to avoid collisions
// with existing (tenant_id, scouting_observation_id) foreign-key indexes.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE INDEX idx_evidence_scouting_tenant_history
      ON evidence_assets (tenant_id, created_at DESC, id DESC)
      INCLUDE (scouting_observation_id)
      WHERE scouting_observation_id IS NOT NULL;
    CREATE INDEX idx_scouting_observations_tenant_run_id
      ON scouting_observations (tenant_id, scouting_run_id, id);
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP INDEX IF EXISTS idx_scouting_observations_tenant_run_id;
    DROP INDEX IF EXISTS idx_evidence_scouting_tenant_history;
  `);
}
