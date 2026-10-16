// 0T.10: link private evidence bytes to the exact immutable execution declaration.
// Leave legacy order attachments and all scouting observations untouched.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE work_order_executions ADD CONSTRAINT ux_work_execution_order_link
      UNIQUE (tenant_id, work_order_id, id);
    ALTER TABLE evidence_assets ADD COLUMN work_order_execution_id uuid;
    ALTER TABLE evidence_assets ADD CONSTRAINT execution_evidence_scope CHECK (
      work_order_execution_id IS NULL OR
      (work_order_id IS NOT NULL AND scouting_observation_id IS NULL)
    );
    ALTER TABLE evidence_assets ADD CONSTRAINT execution_evidence_same_order_tenant_fk
      FOREIGN KEY (tenant_id, work_order_id, work_order_execution_id)
      REFERENCES work_order_executions(tenant_id, work_order_id, id)
      ON DELETE CASCADE;
    CREATE INDEX idx_evidence_execution_history
      ON evidence_assets(tenant_id, work_order_id, work_order_execution_id, created_at DESC, id DESC)
      WHERE work_order_execution_id IS NOT NULL;
  `);
}

// Never erase links for users' private evidence as a casual rollback.
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM evidence_assets WHERE work_order_execution_id IS NOT NULL LIMIT 1) THEN
        RAISE EXCEPTION 'Cannot rollback execution evidence while attached files exist; preserve/export first';
      END IF;
    END $$;
    DROP INDEX IF EXISTS idx_evidence_execution_history;
    ALTER TABLE evidence_assets DROP CONSTRAINT IF EXISTS execution_evidence_same_order_tenant_fk;
    ALTER TABLE evidence_assets DROP CONSTRAINT IF EXISTS execution_evidence_scope;
    ALTER TABLE evidence_assets DROP COLUMN IF EXISTS work_order_execution_id;
    ALTER TABLE work_order_executions DROP CONSTRAINT IF EXISTS ux_work_execution_order_link;
  `);
}
