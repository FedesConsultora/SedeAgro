export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email citext NOT NULL UNIQUE,
      password_hash text NOT NULL,
      full_name varchar(180) NOT NULL,
      phone varchar(80),
      status varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'deleted')),
      is_platform_admin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code varchar(80) NOT NULL UNIQUE,
      name varchar(140) NOT NULL,
      max_users integer NOT NULL DEFAULT 5 CHECK (max_users > 0),
      limits jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE modules (
      code varchar(80) PRIMARY KEY,
      name varchar(140) NOT NULL,
      description text,
      is_starter boolean NOT NULL DEFAULT false
    );

    CREATE TABLE plan_modules (
      plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      module_code varchar(80) NOT NULL REFERENCES modules(code) ON DELETE CASCADE,
      PRIMARY KEY (plan_id, module_code)
    );

    CREATE TABLE roles (
      code varchar(80) PRIMARY KEY,
      name varchar(140) NOT NULL,
      scope varchar(24) NOT NULL CHECK (scope IN ('platform', 'tenant')),
      description text
    );

    CREATE TABLE permissions (
      code varchar(120) PRIMARY KEY,
      description text
    );

    CREATE TABLE role_permissions (
      role_code varchar(80) NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
      permission_code varchar(120) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
      PRIMARY KEY (role_code, permission_code)
    );

    CREATE TABLE tenants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
      name varchar(180) NOT NULL,
      slug varchar(90) NOT NULL UNIQUE,
      status varchar(24) NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'suspended', 'deleted')),
      default_locale varchar(12) NOT NULL DEFAULT 'es-AR',
      timezone varchar(80) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
      billing_email citext,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );

    CREATE TABLE memberships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_code varchar(80) NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
      status varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'blocked')),
      is_bot boolean NOT NULL DEFAULT false,
      joined_at timestamptz,
      invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, user_id)
    );

    CREATE TABLE tenant_modules (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      module_code varchar(80) NOT NULL REFERENCES modules(code) ON DELETE CASCADE,
      is_enabled boolean NOT NULL DEFAULT true,
      source varchar(24) NOT NULL DEFAULT 'plan' CHECK (source IN ('plan', 'override')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, module_code)
    );

    CREATE TABLE tenant_integrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider varchar(80) NOT NULL,
      credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, provider)
    );

    CREATE TABLE platform_audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
      tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
      action varchar(120) NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE tenant_seat_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      snapshot_at timestamptz NOT NULL,
      active_count integer NOT NULL CHECK (active_count >= 0),
      limit_count integer NOT NULL CHECK (limit_count >= 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_memberships_user ON memberships(user_id);
    CREATE INDEX idx_memberships_tenant_status ON memberships(tenant_id, status);
    CREATE INDEX idx_tenant_modules_enabled ON tenant_modules(tenant_id, is_enabled);
    CREATE INDEX idx_platform_audit_tenant_time ON platform_audit_logs(tenant_id, created_at DESC);
    CREATE UNIQUE INDEX idx_tenant_seat_usage_day ON tenant_seat_usage(tenant_id, snapshot_at);
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP TABLE IF EXISTS tenant_seat_usage;
    DROP TABLE IF EXISTS platform_audit_logs;
    DROP TABLE IF EXISTS tenant_integrations;
    DROP TABLE IF EXISTS tenant_modules;
    DROP TABLE IF EXISTS memberships;
    DROP TABLE IF EXISTS tenants;
    DROP TABLE IF EXISTS role_permissions;
    DROP TABLE IF EXISTS permissions;
    DROP TABLE IF EXISTS roles;
    DROP TABLE IF EXISTS plan_modules;
    DROP TABLE IF EXISTS modules;
    DROP TABLE IF EXISTS plans;
    DROP TABLE IF EXISTS users;
  `);
}
