// 0T.28: sharing is a reversible visibility change on an existing personal view.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    ALTER TABLE work_order_review_views
      ADD COLUMN visibility varchar(16) NOT NULL DEFAULT 'private'
      CONSTRAINT review_view_visibility_check
        CHECK (visibility IN ('private','shared'));
    CREATE UNIQUE INDEX ux_review_view_tenant_shared_name
      ON work_order_review_views (tenant_id, lower(name))
      WHERE visibility = 'shared';
    CREATE INDEX idx_review_view_shared_tenant
      ON work_order_review_views (tenant_id, created_at DESC, id DESC)
      WHERE visibility = 'shared';
  `);
}
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_review_views WHERE visibility = 'shared') THEN
        RAISE EXCEPTION 'Cannot rollback while views are shared; unshare or export first';
      END IF;
    END $$;
    DROP INDEX IF EXISTS idx_review_view_shared_tenant;
    DROP INDEX IF EXISTS ux_review_view_tenant_shared_name;
    ALTER TABLE work_order_review_views DROP COLUMN visibility;
  `);
}
