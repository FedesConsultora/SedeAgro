// Introduce idempotency only for new sync submissions; historical received
// batches remain untouched and cannot collide with the new unique index.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE sync_batches
      ADD COLUMN idempotency_key uuid,
      ADD COLUMN request_hash varchar(64);
    CREATE UNIQUE INDEX idx_sync_batches_tenant_actor_idempotency
      ON sync_batches (tenant_id, submitted_by, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    ALTER TABLE sync_operations
      ADD COLUMN result jsonb;
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE sync_operations DROP COLUMN IF EXISTS result;
    DROP INDEX IF EXISTS idx_sync_batches_tenant_actor_idempotency;
    ALTER TABLE sync_batches DROP COLUMN IF EXISTS request_hash;
    ALTER TABLE sync_batches DROP COLUMN IF EXISTS idempotency_key;
  `);
}
