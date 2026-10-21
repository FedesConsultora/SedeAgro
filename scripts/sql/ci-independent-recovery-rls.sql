-- 0P.23: RLS acceptance IN AN INDEPENDENT CI RECOVERY INSTANCE ONLY.
-- This script refuses other DBs, creates two synthetic tenants in one
-- transaction, switches to the least-privilege application role and rolls back.
-- Never run against staging, production or an operator-provided database.
\set ON_ERROR_STOP on
BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'sedeagro_restore_test'
     OR current_setting('is_superuser') <> 'on'
     OR session_user <> 'sedeagro_owner' THEN
    RAISE EXCEPTION 'BLOCKED 0P23: requires isolated disposable restore owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM plans WHERE code = 'starter') THEN
    RAISE EXCEPTION 'BLOCKED 0P23: missing synthetic starter plan';
  END IF;
  IF EXISTS (SELECT 1 FROM tenants
    WHERE id IN ('a2300000-0000-4000-8000-000000000001'::uuid,
                 'b2300000-0000-4000-8000-000000000002'::uuid)) THEN
    RAISE EXCEPTION 'BLOCKED 0P23: synthetic fixture already present';
  END IF;
END
$guard$;

INSERT INTO tenants (id, plan_id, name, slug, status)
SELECT 'a2300000-0000-4000-8000-000000000001'::uuid, id,
  'CI independent restore A', 'ci-0p23-independent-a', 'active'
FROM plans WHERE code = 'starter';
INSERT INTO tenants (id, plan_id, name, slug, status)
SELECT 'b2300000-0000-4000-8000-000000000002'::uuid, id,
  'CI independent restore B', 'ci-0p23-independent-b', 'active'
FROM plans WHERE code = 'starter';

INSERT INTO report_worker_presence (tenant_id)
VALUES
  ('a2300000-0000-4000-8000-000000000001'::uuid),
  ('b2300000-0000-4000-8000-000000000002'::uuid);

-- SECURITY DEFINER is not involved. The session switches to the real
-- non-owner application role created on the independently restored DB.
SET LOCAL ROLE sedeagro_app;

DO $isolation$
DECLARE
  flags record;
  visible bigint;
  affected bigint;
BEGIN
  SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
    pg_get_userbyid(d.datdba) AS db_owner
  INTO flags
  FROM pg_roles r
  CROSS JOIN pg_database d
  WHERE r.rolname = current_user AND d.datname = current_database();

  IF current_user <> 'sedeagro_app' OR
     flags.rolsuper IS DISTINCT FROM false OR
     flags.rolbypassrls IS DISTINCT FROM false OR
     flags.rolcreaterole IS DISTINCT FROM false OR
     flags.rolcreatedb IS DISTINCT FROM false OR
     flags.db_owner = current_user THEN
    RAISE EXCEPTION 'BLOCKED 0P23: restored runtime DB role is privileged';
  END IF;
  IF NOT row_security_active('public.report_worker_presence'::regclass) THEN
    RAISE EXCEPTION 'BLOCKED 0P23: RLS inactive for restored application role';
  END IF;

  PERFORM set_config('app.current_tenant', '', true);
  SELECT count(*) INTO visible FROM report_worker_presence
  WHERE tenant_id IN ('a2300000-0000-4000-8000-000000000001'::uuid,
                      'b2300000-0000-4000-8000-000000000002'::uuid);
  IF visible <> 0 THEN
    RAISE EXCEPTION 'BLOCKED 0P23: tenant data visible without a context';
  END IF;

  PERFORM set_config('app.current_tenant',
    'a2300000-0000-4000-8000-000000000001', true);
  SELECT count(*) INTO visible FROM report_worker_presence
  WHERE tenant_id IN ('a2300000-0000-4000-8000-000000000001'::uuid,
                      'b2300000-0000-4000-8000-000000000002'::uuid);
  IF visible <> 1 OR NOT EXISTS (
      SELECT 1 FROM report_worker_presence
      WHERE tenant_id = 'a2300000-0000-4000-8000-000000000001'::uuid) OR
      EXISTS (
      SELECT 1 FROM report_worker_presence
      WHERE tenant_id = 'b2300000-0000-4000-8000-000000000002'::uuid) THEN
    RAISE EXCEPTION 'BLOCKED 0P23: tenant A can read tenant B';
  END IF;

  UPDATE report_worker_presence SET last_seen_at = now()
    WHERE tenant_id = 'b2300000-0000-4000-8000-000000000002'::uuid;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'BLOCKED 0P23: tenant A can write tenant B';
  END IF;

  PERFORM set_config('app.current_tenant',
    'b2300000-0000-4000-8000-000000000002', true);
  SELECT count(*) INTO visible FROM report_worker_presence
  WHERE tenant_id IN ('a2300000-0000-4000-8000-000000000001'::uuid,
                      'b2300000-0000-4000-8000-000000000002'::uuid);
  IF visible <> 1 OR NOT EXISTS (
      SELECT 1 FROM report_worker_presence
      WHERE tenant_id = 'b2300000-0000-4000-8000-000000000002'::uuid) OR
      EXISTS (
      SELECT 1 FROM report_worker_presence
      WHERE tenant_id = 'a2300000-0000-4000-8000-000000000001'::uuid) THEN
    RAISE EXCEPTION 'BLOCKED 0P23: tenant B can read tenant A';
  END IF;
END
$isolation$;

-- Both fixtures are discarded; only the independently recovered archive
-- ever wrote persistent DB data in this ephemeral Docker container.
ROLLBACK;
