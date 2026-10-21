// DB-backed read-only health inspection. Requires a tenant-bound, non-privileged
// role and PostgreSQL transaction-local FORCE RLS. Does not fetch private rows.
import { isSafeRuntimeDbRole } from '../core/tenantDbSafety.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const REPORT_HEALTH_SQL = `
  SELECT
    (SELECT GREATEST(0, EXTRACT(EPOCH FROM now()-p.last_seen_at))::double precision
       FROM report_worker_presence p WHERE p.tenant_id=$1::uuid) AS heartbeat_age_seconds,
    count(*) FILTER (WHERE r.status='queued')::integer AS queued_count,
    (max(GREATEST(0, EXTRACT(EPOCH FROM now()-r.created_at))) FILTER
      (WHERE r.status='queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now())))::double precision AS oldest_ready_age_seconds,
    count(*) FILTER (WHERE r.status='running' AND r.lease_expires_at>now())::integer AS running_count,
    count(*) FILTER (WHERE r.status='running' AND r.lease_expires_at<now()-interval '15 seconds')::integer AS overdue_lease_count,
    count(*) FILTER (WHERE r.status='failed' AND r.updated_at>=now()-interval '10 minutes')::integer AS recent_failed_count
  FROM report_runs r WHERE r.tenant_id=$1::uuid
`;

const fields = ['queued_count', 'running_count', 'overdue_lease_count', 'recent_failed_count'];

export function classifyReportWorkerHealth(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid health snapshot');
  const values = {};
  for (const key of fields) {
    const value = snapshot[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid health counters');
    values[key] = value;
  }
  for (const key of ['heartbeat_age_seconds', 'oldest_ready_age_seconds']) {
    const value = snapshot[key];
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error('Invalid health age');
    }
    values[key] = value === null ? null : Math.floor(value);
  }

  const critical = [];
  const warning = [];
  if (values.heartbeat_age_seconds === null) critical.push('HEARTBEAT_MISSING');
  else if (values.heartbeat_age_seconds >= 20) critical.push('HEARTBEAT_STALE');
  if (values.overdue_lease_count > 0) critical.push('LEASE_OVERDUE');
  if (values.oldest_ready_age_seconds !== null && values.oldest_ready_age_seconds >= 300) {
    critical.push('QUEUE_STALLED');
  } else if (values.oldest_ready_age_seconds !== null && values.oldest_ready_age_seconds >= 120) {
    warning.push('QUEUE_DELAYED');
  }
  if (values.recent_failed_count > 0) warning.push('RECENT_FAILURES');
  if (values.queued_count >= 10) warning.push('QUEUE_AT_CAPACITY');
  if (values.running_count > 2) critical.push('RUNNING_OVER_CAPACITY');

  const status = critical.length ? 'critical' : warning.length ? 'warning' : 'healthy';
  return { status, reason_codes: [...critical, ...warning], metrics: values };
}

export async function inspectReportWorkerHealth(client, tenantId) {
  if (!UUID.test(tenantId || '')) throw new Error('Health check requires one canonical tenant UUID');
  // Check actual DB role first; no superuser/schema-owner snapshot may be trusted.
  const { rows: [role] } = await client.query(`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
           pg_get_userbyid(d.datdba) AS db_owner
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
    WHERE r.rolname=current_user
  `);
  if (!isSafeRuntimeDbRole(role)) throw new Error('Unsafe runtime role for report worker health');
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const { rows } = await client.query(REPORT_HEALTH_SQL, [tenantId]);
    if (rows.length !== 1) throw new Error('Invalid health cardinality');
    const result = classifyReportWorkerHealth(rows[0]);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* original error is authoritative */ }
    throw error;
  }
}
