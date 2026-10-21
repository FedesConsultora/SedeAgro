-- 0P.18: CI-only content parity on the SAME disposable PostgreSQL 16/PostGIS server.
-- Run as the CI bootstrap superuser, otherwise FORCE RLS can silently mask rows.
-- Reads application tables and sequence state; no values or row hashes are printed.
-- The sole write is a session-local temporary table (automatically discarded).
DO $guard$
BEGIN
  IF current_setting('is_superuser') <> 'on' THEN
    RAISE EXCEPTION 'CI restore fingerprint requires disposable bootstrap superuser (RLS bypass)';
  END IF;
  IF current_database() NOT IN ('sedeagro_test', 'sedeagro_restore_test') THEN
    RAISE EXCEPTION 'CI restore fingerprint refuses a non-disposable database';
  END IF;
END
$guard$;

CREATE TEMP TABLE sedeagro_ci_restore_fingerprint (
  kind text NOT NULL,
  relation_name text NOT NULL,
  row_count bigint NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (kind, relation_name)
);

DO $fingerprint$
DECLARE
  item record;
BEGIN
  -- One aggregate per application relation. Exclude extension-owned tables
  -- such as PostGIS spatial_ref_sys and child partitions already read by parent.
  FOR item IN
    SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
      AND NOT c.relispartition
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS d
        WHERE d.classid = 'pg_catalog.pg_class'::regclass
          AND d.refclassid = 'pg_catalog.pg_extension'::regclass
          AND d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY c.relkind, c.relname
  LOOP
    IF item.relkind = 'S' THEN
      EXECUTE format(
        'INSERT INTO pg_temp.sedeagro_ci_restore_fingerprint
           SELECT %L, %L, 1::bigint, md5(last_value::text || '':'' || is_called::text)
           FROM %I.%I',
        'sequence', item.object_name, item.schema_name, item.object_name
      );
    ELSE
      EXECUTE format(
        'INSERT INTO pg_temp.sedeagro_ci_restore_fingerprint
           SELECT %L, %L, count(*)::bigint,
                  md5(coalesce(string_agg(row_digest, '''' ORDER BY row_digest), ''''))
           FROM (
             SELECT md5(row_to_json(t)::text) AS row_digest FROM %I.%I AS t
           ) AS rows',
        'table', item.object_name, item.schema_name, item.object_name
      );
    END IF;
  END LOOP;
END
$fingerprint$;

-- Output ONLY number of relations, number of sequences and a combined digest.
-- Sorted per-row SHA-equivalent fingerprints (MD5 here used for deterministic
-- integrity comparison, NOT cryptographic authenticity) detect same-count edits.
SELECT
  count(*) FILTER (WHERE kind = 'table')::text || '|' ||
  count(*) FILTER (WHERE kind = 'sequence')::text || '|' ||
  md5(coalesce(
    string_agg(kind || '/' || relation_name || '/' || row_count::text || '/' || digest,
               E'\n' ORDER BY kind, relation_name), ''
  ))
FROM pg_temp.sedeagro_ci_restore_fingerprint;
