// Append-only administrative revocation evidence. No view FK: deletion of the
// saved view must not erase moderation history. Tenant deletion retains no data.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE work_order_review_view_moderation_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      view_id uuid NOT NULL,
      view_owner_id uuid NOT NULL,
      actor_user_id uuid NOT NULL,
      view_name varchar(48) NOT NULL,
      action varchar(24) NOT NULL DEFAULT 'revoke_share'
        CHECK (action = 'revoke_share'),
      reason varchar(200) NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 8 AND 200),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_review_view_moderation_tenant_latest
      ON work_order_review_view_moderation_audit
      (tenant_id, created_at DESC, id DESC);
    ALTER TABLE work_order_review_view_moderation_audit ENABLE ROW LEVEL SECURITY;
    ALTER TABLE work_order_review_view_moderation_audit FORCE ROW LEVEL SECURITY;
    CREATE POLICY review_view_moderation_read
      ON work_order_review_view_moderation_audit FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY review_view_moderation_append
      ON work_order_review_view_moderation_audit FOR INSERT
      WITH CHECK (tenant_id = app.current_tenant_id());
    -- No UPDATE or DELETE RLS policies exist: events cannot be edited/removed
    -- by the application role even if a view/author is later deleted.
  `);
}
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_review_view_moderation_audit) THEN
        RAISE EXCEPTION 'Refusing to destroy moderation audit events on rollback';
      END IF;
    END $$;
    DROP TABLE work_order_review_view_moderation_audit;
  `);
}
