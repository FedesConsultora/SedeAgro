// 0R.4 — Immutable, tenant-local provenance from an observed scouting finding
// to an authored work order. No notes, GPS, photographs or recipient access are
// copied into this table. Parents are tied by composite FKs in PostgreSQL,
// not by client-provided UUIDs or string references in instructions.
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    -- Composite candidate keys enforce the full chain at the database layer:
    -- order(tenant,lote,campaña) ↔ run(tenant,campaña) ↔ observation(tenant,run,lote).
    ALTER TABLE work_orders ADD CONSTRAINT uq_order_observation_origin_identity
      UNIQUE (tenant_id, id, field_id, campaign_field_id);
    ALTER TABLE scouting_runs ADD CONSTRAINT uq_run_observation_origin_identity
      UNIQUE (tenant_id, id, campaign_field_id);
    ALTER TABLE scouting_observations ADD CONSTRAINT uq_observation_origin_identity
      UNIQUE (tenant_id, id, scouting_run_id, field_id);

    CREATE TABLE work_order_observation_origins (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      work_order_id uuid NOT NULL,
      scouting_observation_id uuid NOT NULL,
      scouting_run_id uuid NOT NULL,
      field_id uuid NOT NULL,
      campaign_field_id uuid NOT NULL,
      created_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, work_order_id),
      CONSTRAINT order_observation_origin_work_order_fk
        FOREIGN KEY (tenant_id, work_order_id, field_id, campaign_field_id)
        REFERENCES work_orders(tenant_id, id, field_id, campaign_field_id)
        ON DELETE CASCADE,
      CONSTRAINT order_observation_origin_observation_fk
        FOREIGN KEY (tenant_id, scouting_observation_id, scouting_run_id, field_id)
        REFERENCES scouting_observations(tenant_id, id, scouting_run_id, field_id)
        ON DELETE RESTRICT,
      CONSTRAINT order_observation_origin_run_fk
        FOREIGN KEY (tenant_id, scouting_run_id, campaign_field_id)
        REFERENCES scouting_runs(tenant_id, id, campaign_field_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX idx_order_observation_origin_source
      ON work_order_observation_origins(tenant_id, scouting_observation_id);
    CREATE INDEX idx_order_observation_origin_run
      ON work_order_observation_origins(tenant_id, scouting_run_id);

    ALTER TABLE work_order_observation_origins ENABLE ROW LEVEL SECURITY;
    ALTER TABLE work_order_observation_origins FORCE ROW LEVEL SECURITY;
    CREATE POLICY order_observation_origin_tenant_isolation
      ON work_order_observation_origins
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

// Never erase provenance while a linked order exists. Explicit operator
// intervention is required after exporting all affected order records.
export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM work_order_observation_origins LIMIT 1) THEN
        RAISE EXCEPTION 'Refusing to erase persisted order-observation provenance';
      END IF;
    END $$;
    DROP TABLE work_order_observation_origins;
    ALTER TABLE scouting_observations DROP CONSTRAINT uq_observation_origin_identity;
    ALTER TABLE scouting_runs DROP CONSTRAINT uq_run_observation_origin_identity;
    ALTER TABLE work_orders DROP CONSTRAINT uq_order_observation_origin_identity;
  `);
}
