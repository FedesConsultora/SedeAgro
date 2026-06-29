export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE teams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name varchar(160) NOT NULL,
      scope varchar(40) NOT NULL DEFAULT 'field_ops' CHECK (scope IN ('field_ops', 'agronomy', 'contractor', 'client', 'support')),
      farm_id uuid,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, name),
      CONSTRAINT teams_farm_same_tenant_fk
        FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE SET NULL (farm_id)
    );

    CREATE TABLE team_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      team_id uuid NOT NULL,
      user_id uuid NOT NULL,
      role_label varchar(80) NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, team_id, user_id),
      CONSTRAINT team_members_team_same_tenant_fk
        FOREIGN KEY (tenant_id, team_id) REFERENCES teams(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT team_members_user_membership_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
    );

    CREATE TABLE machinery (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name varchar(180) NOT NULL,
      kind varchar(60) NOT NULL CHECK (kind IN ('tractor', 'sprayer', 'seeder', 'harvester', 'drone', 'irrigation', 'sensor', 'vehicle', 'other')),
      brand varchar(120),
      model varchar(120),
      serial_number varchar(120),
      status varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive', 'archived')),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, serial_number)
    );

    CREATE TABLE agricultural_inputs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name varchar(180) NOT NULL,
      category varchar(60) NOT NULL CHECK (category IN ('seed', 'herbicide', 'insecticide', 'fungicide', 'fertilizer', 'adjuvant', 'biological', 'other')),
      unit varchar(40) NOT NULL,
      active_ingredient varchar(180),
      registration_number varchar(120),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, name)
    );

    CREATE TABLE work_order_inputs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      work_order_id uuid NOT NULL,
      input_id uuid NOT NULL,
      dose numeric(12,4) CHECK (dose IS NULL OR dose >= 0),
      dose_unit varchar(40),
      total_quantity numeric(12,4) CHECK (total_quantity IS NULL OR total_quantity >= 0),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, work_order_id, input_id),
      CONSTRAINT work_order_inputs_order_same_tenant_fk
        FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT work_order_inputs_input_same_tenant_fk
        FOREIGN KEY (tenant_id, input_id) REFERENCES agricultural_inputs(tenant_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE work_order_machinery (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      work_order_id uuid NOT NULL,
      machinery_id uuid NOT NULL,
      role varchar(80) NOT NULL DEFAULT 'primary',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, work_order_id, machinery_id),
      CONSTRAINT work_order_machinery_order_same_tenant_fk
        FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT work_order_machinery_machine_same_tenant_fk
        FOREIGN KEY (tenant_id, machinery_id) REFERENCES machinery(tenant_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE satellite_layers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      field_id uuid NOT NULL,
      provider varchar(80) NOT NULL,
      layer_type varchar(40) NOT NULL CHECK (layer_type IN ('ndvi', 'gndvi', 'rgb', 'evi', 'moisture', 'other')),
      captured_at timestamptz NOT NULL,
      storage_key text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, field_id, layer_type, captured_at),
      CONSTRAINT satellite_layers_field_same_tenant_fk
        FOREIGN KEY (tenant_id, field_id) REFERENCES fields(tenant_id, id) ON DELETE CASCADE
    );

    CREATE TABLE report_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name varchar(180) NOT NULL,
      code varchar(80) NOT NULL,
      scope varchar(40) NOT NULL CHECK (scope IN ('field', 'campaign', 'producer', 'tenant', 'work_order')),
      format varchar(24) NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf', 'xlsx', 'csv')),
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, code)
    );

    CREATE TABLE report_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      report_template_id uuid NOT NULL,
      requested_by uuid,
      status varchar(24) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      period_start date,
      period_end date,
      filters jsonb NOT NULL DEFAULT '{}'::jsonb,
      storage_key text,
      generated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
      CONSTRAINT report_runs_template_same_tenant_fk
        FOREIGN KEY (tenant_id, report_template_id) REFERENCES report_templates(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT report_runs_requester_membership_fk
        FOREIGN KEY (tenant_id, requested_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (requested_by)
    );

    CREATE TABLE sync_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      submitted_by uuid,
      client_id varchar(120) NOT NULL,
      device_id varchar(120),
      status varchar(24) NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed')),
      received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      conflict_count integer NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
      UNIQUE (tenant_id, id),
      CONSTRAINT sync_batches_submitter_membership_fk
        FOREIGN KEY (tenant_id, submitted_by) REFERENCES memberships(tenant_id, user_id) ON DELETE SET NULL (submitted_by)
    );

    CREATE TABLE sync_operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      sync_batch_id uuid NOT NULL,
      entity_type varchar(80) NOT NULL,
      entity_client_id varchar(120),
      operation varchar(24) NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status varchar(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'conflict', 'failed')),
      error text,
      CONSTRAINT sync_operations_batch_same_tenant_fk
        FOREIGN KEY (tenant_id, sync_batch_id) REFERENCES sync_batches(tenant_id, id) ON DELETE CASCADE
    );

    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      type varchar(80) NOT NULL,
      title varchar(180) NOT NULL,
      body text,
      entity_type varchar(80),
      entity_id uuid,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CONSTRAINT notifications_user_membership_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
    );

    CREATE INDEX idx_teams_tenant_scope ON teams(tenant_id, scope);
    CREATE INDEX idx_team_members_user ON team_members(tenant_id, user_id);
    CREATE INDEX idx_machinery_tenant_kind ON machinery(tenant_id, kind, status);
    CREATE INDEX idx_inputs_tenant_category ON agricultural_inputs(tenant_id, category);
    CREATE INDEX idx_work_order_inputs_order ON work_order_inputs(tenant_id, work_order_id);
    CREATE INDEX idx_work_order_machinery_order ON work_order_machinery(tenant_id, work_order_id);
    CREATE INDEX idx_satellite_layers_field_time ON satellite_layers(tenant_id, field_id, captured_at DESC);
    CREATE INDEX idx_report_runs_tenant_status ON report_runs(tenant_id, status, created_at DESC);
    CREATE INDEX idx_sync_batches_tenant_user ON sync_batches(tenant_id, submitted_by, received_at DESC);
    CREATE INDEX idx_sync_operations_batch ON sync_operations(tenant_id, sync_batch_id, status);
    CREATE INDEX idx_notifications_user_unread ON notifications(tenant_id, user_id, read_at, created_at DESC);
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS sync_operations;
    DROP TABLE IF EXISTS sync_batches;
    DROP TABLE IF EXISTS report_runs;
    DROP TABLE IF EXISTS report_templates;
    DROP TABLE IF EXISTS satellite_layers;
    DROP TABLE IF EXISTS work_order_machinery;
    DROP TABLE IF EXISTS work_order_inputs;
    DROP TABLE IF EXISTS agricultural_inputs;
    DROP TABLE IF EXISTS machinery;
    DROP TABLE IF EXISTS team_members;
    DROP TABLE IF EXISTS teams;
  `);
}
