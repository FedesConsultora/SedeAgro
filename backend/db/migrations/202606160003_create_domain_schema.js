export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE producers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name varchar(180) NOT NULL,
      tax_id varchar(64),
      contact_email citext,
      contact_phone varchar(80),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, name)
    );

    CREATE TABLE farms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      producer_id uuid,
      name varchar(180) NOT NULL,
      locality varchar(140),
      province varchar(140),
      country varchar(80) NOT NULL DEFAULT 'Argentina',
      centroid geometry(Point, 4326),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, name),
      CONSTRAINT farms_producer_same_tenant_fk
        FOREIGN KEY (tenant_id, producer_id) REFERENCES producers(tenant_id, id) ON DELETE SET NULL (producer_id)
    );

    CREATE TABLE fields (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      farm_id uuid NOT NULL,
      name varchar(180) NOT NULL,
      area_hectares numeric(12,2) NOT NULL DEFAULT 0 CHECK (area_hectares >= 0),
      boundary geometry(Polygon, 4326),
      status varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, farm_id, name),
      CONSTRAINT fields_farm_same_tenant_fk
        FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
    );

    CREATE TABLE crop_types (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code varchar(80) NOT NULL UNIQUE,
      name varchar(140) NOT NULL
    );

    CREATE TABLE crop_varieties (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      crop_type_id uuid NOT NULL REFERENCES crop_types(id) ON DELETE CASCADE,
      name varchar(140) NOT NULL,
      UNIQUE (crop_type_id, name)
    );

    CREATE TABLE campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name varchar(160) NOT NULL,
      season_year integer NOT NULL CHECK (season_year >= 2000),
      starts_at date NOT NULL,
      ends_at date,
      status varchar(24) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'closed', 'archived')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, name),
      CHECK (ends_at IS NULL OR ends_at >= starts_at)
    );

    CREATE TABLE campaign_fields (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id uuid NOT NULL,
      field_id uuid NOT NULL,
      crop_type_id uuid NOT NULL REFERENCES crop_types(id) ON DELETE RESTRICT,
      crop_variety_id uuid REFERENCES crop_varieties(id) ON DELETE RESTRICT,
      planting_date date,
      harvest_target_date date,
      expected_yield numeric(12,2),
      status varchar(24) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'harvested', 'closed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, campaign_id, field_id),
      CONSTRAINT campaign_fields_campaign_same_tenant_fk
        FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT campaign_fields_field_same_tenant_fk
        FOREIGN KEY (tenant_id, field_id) REFERENCES fields(tenant_id, id) ON DELETE CASCADE,
      CHECK (harvest_target_date IS NULL OR planting_date IS NULL OR harvest_target_date >= planting_date)
    );

    CREATE TABLE scouting_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_field_id uuid NOT NULL,
      assigned_to uuid,
      scheduled_at timestamptz,
      completed_at timestamptz,
      status varchar(24) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
      summary text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CONSTRAINT scouting_runs_campaign_field_same_tenant_fk
        FOREIGN KEY (tenant_id, campaign_field_id) REFERENCES campaign_fields(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT scouting_runs_assignee_membership_fk
        FOREIGN KEY (tenant_id, assigned_to) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (assigned_to)
    );

    CREATE TABLE scouting_observations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      scouting_run_id uuid NOT NULL,
      field_id uuid NOT NULL,
      observed_by uuid,
      observation_type varchar(40) NOT NULL CHECK (observation_type IN ('weed', 'pest', 'disease', 'phenology', 'nutrition', 'water', 'general')),
      severity varchar(24) NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
      point geometry(Point, 4326),
      notes text,
      observed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CONSTRAINT scouting_observations_run_same_tenant_fk
        FOREIGN KEY (tenant_id, scouting_run_id) REFERENCES scouting_runs(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT scouting_observations_field_same_tenant_fk
        FOREIGN KEY (tenant_id, field_id) REFERENCES fields(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT scouting_observations_observer_membership_fk
        FOREIGN KEY (tenant_id, observed_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (observed_by)
    );

    CREATE TABLE work_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_field_id uuid,
      field_id uuid NOT NULL,
      requested_by uuid,
      type varchar(40) NOT NULL CHECK (type IN ('application', 'sowing', 'fertilization', 'harvest', 'irrigation', 'inspection', 'other')),
      status varchar(32) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'assigned', 'in_progress', 'completed', 'cancelled')),
      priority varchar(24) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      due_at timestamptz,
      title varchar(180) NOT NULL,
      instructions text,
      approved_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CONSTRAINT work_orders_campaign_field_same_tenant_fk
        FOREIGN KEY (tenant_id, campaign_field_id) REFERENCES campaign_fields(tenant_id, id) ON DELETE SET NULL (campaign_field_id),
      CONSTRAINT work_orders_field_same_tenant_fk
        FOREIGN KEY (tenant_id, field_id) REFERENCES fields(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT work_orders_requester_membership_fk
        FOREIGN KEY (tenant_id, requested_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (requested_by)
    );

    CREATE TABLE work_order_assignees (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      work_order_id uuid NOT NULL,
      user_id uuid NOT NULL,
      responsibility varchar(80) NOT NULL DEFAULT 'executor',
      status varchar(24) NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'accepted', 'rejected', 'done')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, work_order_id, user_id),
      CONSTRAINT work_order_assignees_order_same_tenant_fk
        FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT work_order_assignees_user_membership_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
    );

    CREATE TABLE evidence_assets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      scouting_observation_id uuid,
      work_order_id uuid,
      uploaded_by uuid,
      kind varchar(24) NOT NULL CHECK (kind IN ('photo', 'audio', 'document', 'video', 'other')),
      storage_key text NOT NULL,
      original_name varchar(240),
      mime_type varchar(120),
      size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0),
      captured_at timestamptz,
      point geometry(Point, 4326),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CHECK (num_nonnulls(scouting_observation_id, work_order_id) = 1),
      CONSTRAINT evidence_observation_same_tenant_fk
        FOREIGN KEY (tenant_id, scouting_observation_id) REFERENCES scouting_observations(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT evidence_work_order_same_tenant_fk
        FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT evidence_uploader_membership_fk
        FOREIGN KEY (tenant_id, uploaded_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (uploaded_by)
    );

    CREATE TABLE rainfall_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      field_id uuid NOT NULL,
      recorded_by uuid,
      amount_mm numeric(8,2) NOT NULL CHECK (amount_mm >= 0),
      measured_at timestamptz NOT NULL,
      source varchar(40) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sensor', 'import')),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CONSTRAINT rainfall_field_same_tenant_fk
        FOREIGN KEY (tenant_id, field_id) REFERENCES fields(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT rainfall_recorder_membership_fk
        FOREIGN KEY (tenant_id, recorded_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (recorded_by)
    );

    CREATE TABLE irrigation_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      field_id uuid NOT NULL,
      recorded_by uuid,
      amount_mm numeric(8,2) CHECK (amount_mm IS NULL OR amount_mm >= 0),
      started_at timestamptz NOT NULL,
      ended_at timestamptz,
      source varchar(40) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sensor', 'import')),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CHECK (ended_at IS NULL OR ended_at >= started_at),
      CONSTRAINT irrigation_field_same_tenant_fk
        FOREIGN KEY (tenant_id, field_id) REFERENCES fields(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT irrigation_recorder_membership_fk
        FOREIGN KEY (tenant_id, recorded_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (recorded_by)
    );

    CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id uuid,
      action varchar(120) NOT NULL,
      entity_type varchar(80) NOT NULL,
      entity_id uuid,
      before jsonb,
      after jsonb,
      request_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CONSTRAINT audit_actor_membership_fk
        FOREIGN KEY (tenant_id, actor_id) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (actor_id)
    );

    CREATE INDEX idx_producers_tenant_name ON producers(tenant_id, name);
    CREATE INDEX idx_farms_tenant_producer ON farms(tenant_id, producer_id);
    CREATE INDEX idx_fields_tenant_farm ON fields(tenant_id, farm_id);
    CREATE INDEX idx_fields_boundary_gist ON fields USING gist(boundary);
    CREATE INDEX idx_campaigns_tenant_status ON campaigns(tenant_id, status);
    CREATE INDEX idx_campaign_fields_tenant_crop ON campaign_fields(tenant_id, crop_type_id);
    CREATE INDEX idx_scouting_runs_tenant_status ON scouting_runs(tenant_id, status);
    CREATE INDEX idx_scouting_observations_tenant_type ON scouting_observations(tenant_id, observation_type, severity);
    CREATE INDEX idx_scouting_observations_point_gist ON scouting_observations USING gist(point);
    CREATE INDEX idx_work_orders_tenant_status ON work_orders(tenant_id, status, due_at);
    CREATE INDEX idx_work_order_assignees_user ON work_order_assignees(tenant_id, user_id, status);
    CREATE INDEX idx_evidence_tenant_observation ON evidence_assets(tenant_id, scouting_observation_id);
    CREATE INDEX idx_evidence_tenant_work_order ON evidence_assets(tenant_id, work_order_id);
    CREATE INDEX idx_rainfall_tenant_field_time ON rainfall_events(tenant_id, field_id, measured_at DESC);
    CREATE INDEX idx_irrigation_tenant_field_time ON irrigation_events(tenant_id, field_id, started_at DESC);
    CREATE INDEX idx_audit_tenant_entity_time ON audit_events(tenant_id, entity_type, entity_id, created_at DESC);
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS irrigation_events;
    DROP TABLE IF EXISTS rainfall_events;
    DROP TABLE IF EXISTS evidence_assets;
    DROP TABLE IF EXISTS work_order_assignees;
    DROP TABLE IF EXISTS work_orders;
    DROP TABLE IF EXISTS scouting_observations;
    DROP TABLE IF EXISTS scouting_runs;
    DROP TABLE IF EXISTS campaign_fields;
    DROP TABLE IF EXISTS campaigns;
    DROP TABLE IF EXISTS crop_varieties;
    DROP TABLE IF EXISTS crop_types;
    DROP TABLE IF EXISTS fields;
    DROP TABLE IF EXISTS farms;
    DROP TABLE IF EXISTS producers;
  `);
}
