// 0T.11: persist an explicit, independently authored review checklist.
// Legacy verified declarations remain NULL: do not invent retroactive checks.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE work_order_executions
      ADD COLUMN review_checklist jsonb,
      ADD CONSTRAINT execution_review_checklist_shape CHECK (
        review_checklist IS NULL OR (
          review_status = 'verified'
          AND jsonb_typeof(review_checklist) = 'object'
          AND review_checklist->>'time_checked' = 'true'
          AND review_checklist->>'area_checked' = 'true'
          AND review_checklist->>'result_checked' = 'true'
          AND review_checklist->>'operation_checked' = 'true'
          AND review_checklist->>'evidence_basis' IN ('reviewed_files', 'no_files')
        )
      );
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_executions WHERE review_checklist IS NOT NULL LIMIT 1) THEN
        RAISE EXCEPTION 'Cannot rollback execution review checklist with recorded reviews; preserve/export first';
      END IF;
    END $$;
    ALTER TABLE work_order_executions
      DROP CONSTRAINT IF EXISTS execution_review_checklist_shape,
      DROP COLUMN IF EXISTS review_checklist;
  `);
}
