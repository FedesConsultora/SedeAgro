export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE OR REPLACE FUNCTION app.current_tenant_id()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $$
      SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid;
    $$;
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DROP FUNCTION IF EXISTS app.current_tenant_id();
    DROP SCHEMA IF EXISTS app;
  `);
}
