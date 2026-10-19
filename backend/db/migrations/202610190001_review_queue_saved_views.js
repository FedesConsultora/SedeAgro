// 0T.27 — durable, tenant/member-owned review query views, never cursor tokens.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE work_order_review_views (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      name varchar(48) NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 48),
      filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT review_view_member_scope_fk
        FOREIGN KEY (tenant_id, user_id)
        REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX ux_review_view_user_name
      ON work_order_review_views(tenant_id, user_id, lower(name));
    CREATE INDEX idx_review_view_user_created
      ON work_order_review_views(tenant_id, user_id, created_at DESC, id DESC);
    ALTER TABLE work_order_review_views ENABLE ROW LEVEL SECURITY;
    ALTER TABLE work_order_review_views FORCE ROW LEVEL SECURITY;
    CREATE POLICY review_views_tenant_isolation ON work_order_review_views
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_review_views LIMIT 1) THEN
        RAISE EXCEPTION 'Refusing to destroy saved review views on rollback; export records first';
      END IF;
    END $$;
    DROP TABLE work_order_review_views;
  `);
}
