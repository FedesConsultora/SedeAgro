import { Router } from 'express';
import { z } from 'zod';
import { Op, QueryTypes } from 'sequelize';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { createHash } from 'node:crypto';
import {
  ReportRun, ReportTemplate,
  Field, Farm, CampaignField, Campaign, CropType,
  ScoutingRun, ScoutingObservation, WorkOrder
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate, HttpError } from '../../utils/http.js';
import { buildFieldCsv } from './fieldCsv.js';
import { loadFieldReportSnapshot } from './fieldSnapshot.js';
import { fieldCsvPeriod } from './fieldCsv.js';
import { buildFieldPdf } from './fieldPdf.js';
import { buildFieldXlsx } from './fieldXlsx.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';

export const reportsRouter = Router();

reportsRouter.use(requireEntitlement('reports'));

const templateSchema = z.object({
  name: z.string().min(2).max(180),
  code: z.string().min(2).max(80).regex(/^[a-z0-9_-]+$/i),
  scope: z.enum(['field', 'campaign', 'producer', 'tenant', 'work_order']),
  format: z.enum(['pdf', 'xlsx', 'csv']).default('pdf'),
  config: z.record(z.any()).default({}),
  is_active: z.boolean().default(true)
});

const runSchema = z.object({
  report_template_id: z.string().uuid(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  filters: z.object({ field_id: z.string().uuid() }).strict()
}).strict();

reportsRouter.get('/templates', requireCapability('reports.read'), asyncHandler(async (req, res) => {
  const templates = await ReportTemplate.findAll({
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: templates });
}));

reportsRouter.post('/templates', requireCapability('reports.write'), validate(templateSchema), asyncHandler(async (req, res) => {
  const template = await ReportTemplate.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: template });
}));

// Durable job creation accepts field-scoped templates only, until other
// document scopes are genuinely implemented. Worker is an explicit per-tenant
// service; the API does not pretend that it is automatically running.
reportsRouter.get('/runs', requireCapability('reports.read'), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const runs = await ReportRun.findAll({
    attributes: ['id', 'status', 'attempt_count', 'error_code', 'period_start',
      'period_end', 'requested_by', 'generated_at', 'created_at', 'updated_at'],
    include: [{ model: ReportTemplate, attributes: ['id', 'name', 'format'] }],
    where: { tenant_id: req.tenantId },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: 30,
    transaction: req.dbTransaction
  });
  res.json({ data: runs });
}));

reportsRouter.post('/runs', requireCapability('reports.write'), validate(runSchema),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { fieldCsvPeriod(req.body.period_start, req.body.period_end); }
    catch (error) { throw new HttpError(422, error.message); }
    const tx = req.dbTransaction;
    const template = await ReportTemplate.findOne({ where: {
      id: req.body.report_template_id, tenant_id: req.tenantId, is_active: true
    }, transaction: tx });
    if (!template || template.scope !== 'field' ||
        !['csv', 'pdf', 'xlsx'].includes(template.format)) {
      throw new HttpError(422, 'La plantilla no está disponible para reportes por lote.');
    }
    const field = await Field.findOne({ where: {
      id: req.body.filters.field_id, tenant_id: req.tenantId
    }, attributes: ['id'], transaction: tx });
    if (!field) throw new HttpError(404, 'Lote no encontrado.');
    await queryTenantTransaction(
      'SELECT pg_advisory_xact_lock(hashtext(:tenant)), :tenant AS tenant_id',
      { replacements: { tenant: req.tenantId }, transaction: tx }
    );
    const [presence] = await queryTenantTransaction(`
      SELECT (last_seen_at > now()-interval '20 seconds') AS online
      FROM report_worker_presence WHERE tenant_id=:tenant
    `, { transaction: tx, type: QueryTypes.SELECT,
      replacements: { tenant: req.tenantId } });
    if (!presence?.online) {
      throw new HttpError(503,
        'No hay un procesador de reportes activo para esta empresa. Probá la descarga inmediata.',
        undefined, 'REPORT_WORKER_OFFLINE');
    }
    const count = await ReportRun.count({ where: {
      tenant_id: req.tenantId, status: ['queued', 'running']
    }, transaction: tx });
    if (count >= 10) {
      throw new HttpError(429, 'Máximo 10 reportes pendientes por empresa. Reintentá más tarde.');
    }
    const run = await ReportRun.create({
      tenant_id: req.tenantId,
      report_template_id: template.id,
      requested_by: req.auth.user.id,
      period_start: req.body.period_start || null,
      period_end: req.body.period_end || null,
      filters: { field_id: field.id }, status: 'queued'
    }, { transaction: tx });
    res.status(202).json({ data: {
      id: run.id, status: run.status, attempt_count: 0,
      report_template_id: template.id, format: template.format,
      period_start: run.period_start, period_end: run.period_end
    } });
  }));

reportsRouter.get('/worker-status', requireCapability('reports.read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const [result] = await queryTenantTransaction(`
      SELECT (last_seen_at > now()-interval '20 seconds') AS online
      FROM report_worker_presence WHERE tenant_id=:tenant
    `, { transaction: req.dbTransaction, type: QueryTypes.SELECT,
      replacements: { tenant: req.tenantId } });
    res.json({ data: { online: Boolean(result?.online) } });
  }));

const reportRunId = z.string().uuid();
reportsRouter.get('/runs/:runId', requireCapability('reports.read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!reportRunId.safeParse(req.params.runId).success) throw new HttpError(422, 'Identificador inválido.');
    const run = await ReportRun.findOne({ where: {
      id: req.params.runId, tenant_id: req.tenantId
    }, attributes: ['id', 'status', 'attempt_count', 'error_code',
      'generated_at', 'created_at', 'period_start', 'period_end'],
    include: [{ model: ReportTemplate, attributes: ['name', 'format'] }],
    transaction: req.dbTransaction });
    if (!run) throw new HttpError(404, 'Reporte no encontrado.');
    res.json({ data: run });
  }));

reportsRouter.post('/runs/:runId/cancel', requireCapability('reports.write'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!reportRunId.safeParse(req.params.runId).success) throw new HttpError(422, 'Identificador inválido.');
    const [run] = await queryTenantTransaction(`
      UPDATE report_runs SET status='cancelled', lease_token=NULL,
        lease_expires_at=NULL, next_attempt_at=NULL, updated_at=now()
      WHERE id=:run AND tenant_id=:tenant AND status IN ('queued','running')
      RETURNING id, status
    `, { type: QueryTypes.SELECT, transaction: req.dbTransaction,
      replacements: { run: req.params.runId, tenant: req.tenantId } });
    if (!run) throw new HttpError(409, 'Reporte no pendiente, no disponible o ya finalizado.');
    res.json({ data: run });
  }));

reportsRouter.get('/runs/:runId/download', requireCapability('reports.read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!reportRunId.safeParse(req.params.runId).success) throw new HttpError(422, 'Identificador inválido.');
    const run = await ReportRun.findOne({ where: {
      id: req.params.runId, tenant_id: req.tenantId
    }, include: [{ model: ReportTemplate, attributes: ['format'] }],
    transaction: req.dbTransaction });
    if (!run) throw new HttpError(404, 'Reporte no encontrado.');
    if (run.status !== 'completed') throw new HttpError(409, 'El reporte todavía no está disponible.');
    const [file] = await queryTenantTransaction(`
      SELECT format, mime_type, encode(content, 'base64') AS content_base64,
        octet_length(content)::integer AS size_bytes, sha256
      FROM report_run_files
      WHERE run_id=:run AND tenant_id=:tenant AND expires_at>now()
    `, { transaction: req.dbTransaction, type: QueryTypes.SELECT,
      replacements: { run: run.id, tenant: req.tenantId } });
    if (!file) throw new HttpError(410, 'El archivo de reporte caducó.');
    const bytes = Buffer.from(file.content_base64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256 ||
        bytes.length !== file.size_bytes || file.format !== run.ReportTemplate.format) {
      throw new HttpError(500, 'Integridad del reporte no verificable.');
    }
    res.json({ data: {
      filename: `reporte-lote-${run.filters?.field_id}.${file.format}`,
      mimeType: file.mime_type, size_bytes: file.size_bytes,
      content_base64: file.content_base64, sha256: file.sha256
    } });
  }));

// Field report file downloads are synchronous and strictly bounded.
async function exportFieldDocument(req, res, format) {
  res.set('Cache-Control', 'private, no-store');
  const snapshot = await loadFieldReportSnapshot(req);
  // Reuse the existing 1 MiB source bound for every format.
  buildFieldCsv(snapshot);
  let buffer;
  try {
    buffer = format === 'pdf' ? buildFieldPdf(snapshot) : buildFieldXlsx(snapshot);
  } catch (error) {
    throw new HttpError(error.message.includes('caracteres no admitidos') ? 422 : 413,
      error.message, undefined, 'REPORT_DOCUMENT_REJECTED');
  }
  const mimeType = format === 'pdf' ? 'application/pdf' :
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  res.json({ data: {
    filename: `reporte-lote-${snapshot.field.id}.${format}`,
    mimeType,
    content_base64: buffer.toString('base64'),
    size_bytes: buffer.length,
    counts: { observations: snapshot.observations.length,
      workOrders: snapshot.workOrders.length },
    period: { from: snapshot.period.from, to: snapshot.period.to }
  } });
}

reportsRouter.get('/field/:fieldId/export.pdf', requireCapability('reports.read'),
  asyncHandler((req, res) => exportFieldDocument(req, res, 'pdf')));
reportsRouter.get('/field/:fieldId/export.xlsx', requireCapability('reports.read'),
  asyncHandler((req, res) => exportFieldDocument(req, res, 'xlsx')));

reportsRouter.get('/field/:fieldId/export.csv', requireCapability('reports.read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const snapshot = await loadFieldReportSnapshot(req);
    let csv;
    try {
      csv = buildFieldCsv(snapshot);
    } catch (error) {
      throw new HttpError(413, error.message, undefined, 'REPORT_EXPORT_TOO_LARGE');
    }
    res.json({ data: {
      filename: `reporte-lote-${snapshot.field.id}.csv`,
      mimeType: 'text/csv;charset=utf-8', csv,
      counts: { observations: snapshot.observations.length,
        workOrders: snapshot.workOrders.length },
      period: { from: snapshot.period.from, to: snapshot.period.to }
    } });
  }));

// ─── Field-level report ───────────────────────────────────────
reportsRouter.get('/field/:fieldId', requireCapability('reports.read'), asyncHandler(async (req, res) => {
  const { fieldId } = req.params;
  const tx = req.dbTransaction;

  // 1. Field + Farm
  const field = await Field.findByPk(fieldId, {
    include: [{ model: Farm, attributes: ['id', 'name', 'locality', 'province'] }],
    transaction: tx
  });
  if (!field) return res.status(404).json({ error: { message: 'Lote no encontrado.' } });

  // 2. Active campaign-field (latest)
  const activeCampaignField = await CampaignField.findOne({
    where: { field_id: fieldId },
    include: [
      { model: Campaign, attributes: ['id', 'name', 'season_year', 'status'] },
      { model: CropType, attributes: ['id', 'name', 'code'] }
    ],
    order: [['created_at', 'DESC']],
    transaction: tx
  });

  // 3. Last scouting run with observations
  let lastScoutingRun = null;
  if (activeCampaignField) {
    lastScoutingRun = await ScoutingRun.findOne({
      where: { campaign_field_id: activeCampaignField.id },
      include: [{
        model: ScoutingObservation,
        attributes: ['id', 'observation_type', 'severity', 'notes', 'observed_at']
      }],
      order: [['scheduled_at', 'DESC']],
      transaction: tx
    });
  }

  // 4. Work orders summary
  const allWO = await WorkOrder.findAll({
    where: { field_id: fieldId },
    attributes: ['id', 'title', 'status', 'priority', 'type', 'due_at'],
    order: [['created_at', 'DESC']],
    transaction: tx
  });
  const openStatuses = ['draft', 'pending_approval', 'approved', 'assigned', 'in_progress'];
  const openOrders = allWO.filter((wo) => openStatuses.includes(wo.status));
  const closedOrders = allWO.filter((wo) => ['completed'].includes(wo.status));

  res.json({
    data: {
      field,
      activeCampaignField,
      lastScoutingRun,
      workOrdersSummary: {
        open: openOrders.length,
        closed: closedOrders.length,
        recent: allWO.slice(0, 5)
      }
    }
  });
}));

