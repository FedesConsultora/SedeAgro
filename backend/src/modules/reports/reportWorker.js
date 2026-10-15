// Tenant-bound background processing with Postgres RLS, CAS leases and immutable bytes.
// Every invocation has ONE explicitly configured tenant, never cross-tenant discovery.
import { createHash, randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { withTenantTransaction } from '../../core/db.js';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { loadFieldReportSnapshot } from './fieldSnapshot.js';
import { buildFieldCsv } from './fieldCsv.js';
import { buildFieldPdf } from './fieldPdf.js';
import { buildFieldXlsx } from './fieldXlsx.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const MIME = Object.freeze({
  csv: 'text/csv;charset=utf-8',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
});

export function assertWorkerTenant(tenantId) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw new Error('REPORT_WORKER_TENANT_ID must be a single valid tenant UUID.');
  }
  return tenantId;
}

// Advisory transaction lock serializes claiming within a tenant, including
// different worker processes, without touching other tenants' RLS rows.
export async function claimNextReport(tenantId) {
  assertWorkerTenant(tenantId);
  return withTenantTransaction(async transaction => {
    const [lock] = await queryTenantTransaction(
      'SELECT pg_try_advisory_xact_lock(hashtext(:tenant)) AS acquired, :tenant AS tenant_id',
      { replacements: { tenant: tenantId }, transaction, type: QueryTypes.SELECT }
    );
    if (!lock?.acquired) return null;
    await queryTenantTransaction(`
      UPDATE report_runs SET status='failed', error_code='RETRY_EXHAUSTED',
        lease_token=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE tenant_id=:tenant AND status='running'
        AND lease_expires_at<=now() AND attempt_count>=3
    `, { replacements: { tenant: tenantId }, transaction });
    const [busy] = await queryTenantTransaction(`
      SELECT count(*)::integer AS active FROM report_runs
      WHERE tenant_id=:tenant AND status='running' AND lease_expires_at>now()
    `, { replacements: { tenant: tenantId }, transaction, type: QueryTypes.SELECT });
    if (busy.active >= 2) return null;
    const [run] = await queryTenantTransaction(`
      WITH candidate AS (
        SELECT id FROM report_runs
        WHERE tenant_id=:tenant AND attempt_count<3
          AND ((status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=now()))
            OR (status='running' AND lease_expires_at<=now()))
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE report_runs AS r SET status='running', attempt_count=r.attempt_count+1,
        lease_token=:token, lease_expires_at=now()+interval '120 seconds',
        next_attempt_at=NULL, error_code=NULL, updated_at=now()
      FROM candidate
      WHERE r.id=candidate.id AND r.tenant_id=:tenant
      RETURNING r.id, r.tenant_id, r.report_template_id, r.requested_by,
        r.period_start, r.period_end, r.filters, r.lease_token, r.attempt_count
    `, { replacements: { tenant: tenantId, token: randomUUID() },
      transaction, type: QueryTypes.SELECT });
    return run || null;
  }, tenantId);
}

export function classifyReportFailure(error) {
  const message = String(error?.message || '');
  if (/no admitidos|Fecha|formato|inactivo|deshabilitado/i.test(message)) return 'INVALID_REPORT';
  if (/supera|Demasiados|límite|bytes|páginas/i.test(message)) return 'REPORT_TOO_LARGE';
  if (/no autorizado|revocad|deshabilitad|no encontrado/i.test(message)) return 'AUTHORITY_REVOKED';
  return 'PROCESSING_FAILED';
}

async function renderClaimedReport(run, tenantId) {
  return withTenantTransaction(async tx => {
    const [authority] = await queryTenantTransaction(`
      SELECT t.format, t.scope, t.is_active, t.tenant_id,
        m.role_code, tm.is_enabled
      FROM report_templates t
      LEFT JOIN memberships m ON m.tenant_id=t.tenant_id
        AND m.user_id=:actor AND m.status='active'
      LEFT JOIN tenant_modules tm ON tm.tenant_id=t.tenant_id
        AND tm.module_code='reports' AND tm.is_enabled=true
      WHERE t.tenant_id=:tenant AND t.id=:template
    `, { transaction: tx, replacements: {
      tenant: tenantId, actor: run.requested_by, template: run.report_template_id
    }, type: QueryTypes.SELECT });
    if (!authority || !authority.is_active || !authority.is_enabled ||
        !['tenant_admin', 'agronomic_coordinator'].includes(authority.role_code) ||
        authority.scope !== 'field' || !Object.hasOwn(MIME, authority.format)) {
      throw new Error('Autoridad revocada, plantilla inactiva o formato no admitido.');
    }
    const fieldId = run.filters?.field_id;
    if (typeof fieldId !== 'string' || !UUID.test(fieldId)) throw new Error('Formato de lote no admitido.');
    const snapshot = await loadFieldReportSnapshot({
      query: { ...(run.period_start ? { from: String(run.period_start) } : {}),
        ...(run.period_end ? { to: String(run.period_end) } : {}) },
      params: { fieldId }, tenantId, dbTransaction: tx
    });
    const csv = buildFieldCsv(snapshot); // shared 1MiB / 200+200 cap
    const format = authority.format;
    const bytes = format === 'pdf' ? buildFieldPdf(snapshot) :
      format === 'xlsx' ? buildFieldXlsx(snapshot) : Buffer.from(csv, 'utf8');
    if (bytes.length < 1 || bytes.length > 3145728) throw new Error('Reporte supera límite de bytes.');
    return { format, bytes, mimeType: MIME[format],
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }, tenantId);
}

export async function processNextReport(tenantId) {
  assertWorkerTenant(tenantId);
  const claim = await claimNextReport(tenantId);
  if (!claim) return { state: 'idle' };
  try {
    const file = await renderClaimedReport(claim, tenantId);
    const completed = await withTenantTransaction(async tx => {
      // Atomic update plus immutable bytes. If the request was cancelled or a
      // stalled lease was reclaimed, stale workers may NOT resurrect results.
      const [updated] = await queryTenantTransaction(`
        UPDATE report_runs SET status='completed', lease_token=NULL,
          lease_expires_at=NULL, generated_at=now(), error_code=NULL,
          updated_at=now(), storage_key=NULL
        WHERE tenant_id=:tenant AND id=:run AND status='running'
          AND lease_token=:token AND lease_expires_at>now()
        RETURNING id
      `, { transaction: tx, type: QueryTypes.SELECT,
        replacements: { tenant: tenantId, run: claim.id, token: claim.lease_token } });
      if (!updated) return false;
      await queryTenantTransaction(`
        INSERT INTO report_run_files
          (run_id, tenant_id, format, mime_type, content, sha256, expires_at)
        VALUES (:run, :tenant, :format, :mime, decode(:content,'base64'), :hash,
          now()+interval '7 days')
      `, { transaction: tx, replacements: { tenant: tenantId, run: claim.id,
        format: file.format, mime: file.mimeType,
        content: file.bytes.toString('base64'), hash: file.sha256 } });
      return true;
    }, tenantId);
    return { state: completed ? 'completed' : 'stale', id: claim.id };
  } catch (error) {
    const code = classifyReportFailure(error);
    const state = await withTenantTransaction(async tx => {
      const retryable = code === 'PROCESSING_FAILED' && claim.attempt_count < 3;
      const [updated] = await queryTenantTransaction(`
        UPDATE report_runs SET status=:state, error_code=:code,
          lease_token=NULL, lease_expires_at=NULL,
          next_attempt_at=CASE WHEN :retry THEN now()+interval '15 seconds' ELSE NULL END,
          updated_at=now()
        WHERE tenant_id=:tenant AND id=:run AND status='running'
          AND lease_token=:token AND lease_expires_at>now()
        RETURNING id
      `, { transaction: tx, type: QueryTypes.SELECT, replacements: {
        state: retryable ? 'queued' : 'failed', retry: retryable, code,
        tenant: tenantId, run: claim.id, token: claim.lease_token
      } });
      return updated ? (retryable ? 'retry' : 'failed') : 'stale';
    }, tenantId);
    return { state, id: claim.id, error_code: code };
  }
}

// A heartbeat is necessary but not sufficient to guarantee completion:
// clients also observe bounded leases/retries and explicit failures.
export async function markReportWorkerPresent(tenantId) {
  assertWorkerTenant(tenantId);
  return withTenantTransaction(transaction => queryTenantTransaction(`
    INSERT INTO report_worker_presence(tenant_id,last_seen_at)
    VALUES (:tenant, now())
    ON CONFLICT (tenant_id) DO UPDATE SET last_seen_at=now()
  `, { transaction, replacements: { tenant: tenantId } }), tenantId);
}

export async function purgeExpiredReportFiles(tenantId) {
  assertWorkerTenant(tenantId);
  return withTenantTransaction(async transaction => {
    const [, metadata] = await queryTenantTransaction(`
      DELETE FROM report_run_files WHERE tenant_id=:tenant AND expires_at<=now()
    `, { transaction, replacements: { tenant: tenantId } });
    return metadata?.rowCount ?? 0;
  }, tenantId);
}
