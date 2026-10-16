// 0T.12: immutable per-report snapshot, NOT a warehouse consumption ledger.
// A missing JSON field on historical executions means NOT DECLARED.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE work_order_executions
      ADD COLUMN input_declaration jsonb,
      ADD CONSTRAINT work_execution_input_declaration_shape CHECK (
        input_declaration IS NULL OR (
          jsonb_typeof(input_declaration) = 'object'
          AND jsonb_typeof(input_declaration->'items') = 'array'
          AND jsonb_array_length(input_declaration->'items') <= 25
          AND jsonb_typeof(input_declaration->'declared_by') = 'string'
          AND jsonb_typeof(input_declaration->'client_declaration_id') = 'string'
          AND jsonb_typeof(input_declaration->'declared_at') = 'string'
        )
      );
  `);
}
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_executions WHERE input_declaration IS NOT NULL LIMIT 1) THEN
        RAISE EXCEPTION 'Cannot roll back execution input declarations without preserving existing records';
      END IF;
    END $$;
    ALTER TABLE work_order_executions
      DROP CONSTRAINT IF EXISTS work_execution_input_declaration_shape,
      DROP COLUMN IF EXISTS input_declaration;
  `);
}
