-- Read-only, reusable on the live host (through Compose) AND in CI's
-- disposable PostGIS service. Only extension-owned objects are permissible.
SELECT
  (SELECT count(*) FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname <> 'information_schema'
     AND left(n.nspname, 3) <> 'pg_'
     AND c.relkind IN ('r','p','f','m','v')
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend dep
       WHERE dep.classid = 'pg_class'::regclass
         AND dep.refclassid = 'pg_extension'::regclass
         AND dep.objid = c.oid AND dep.deptype = 'e'
     ))
  || '|' ||
  (SELECT count(*) FROM pg_namespace n
   WHERE n.nspname <> 'public'
     AND n.nspname <> 'information_schema'
     AND left(n.nspname, 3) <> 'pg_'
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend dep
       WHERE dep.classid = 'pg_namespace'::regclass
         AND dep.refclassid = 'pg_extension'::regclass
         AND dep.objid = n.oid AND dep.deptype = 'e'
     ));
