import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import {
  ReportRun, ReportTemplate,
  Field, Farm, CampaignField, Campaign, CropType,
  ScoutingRun, ScoutingObservation, WorkOrder
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate, HttpError } from '../../utils/http.js';
import { buildFieldCsv, fieldCsvPeriod, FIELD_CSV_MAX_ROWS_PER_KIND } from './fieldCsv.js';
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
  period_start: z.coerce.date().optional(),
  period_end: z.coerce.date().optional(),
  filters: z.record(z.any()).default({})
});

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

reportsRouter.get('/runs', requireCapability('reports.read'), asyncHandler(async (req, res) => {
  const runs = await ReportRun.findAll({
    include: [{ model: ReportTemplate, attributes: ['id', 'name', 'code', 'format'] }],
    order: [['created_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: runs });
}));

reportsRouter.post('/runs', requireCapability('reports.write'), validate(runSchema), asyncHandler(async (req, res) => {
  const run = await ReportRun.create({
    ...req.body,
    requested_by: req.auth.user.id,
    status: 'queued'
  }, { transaction: req.dbTransaction });
  res.status(202).json({ data: run });
}));

// 0T.5 — Real, read-only CSV snapshot. It never queues a fake PDF/XLSX job.
// Bound each result before materializing private notes and forbid formula
// execution. All queries participate in the HTTP tenant transaction (FORCE RLS).
const fieldCsvQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
}).strict();

reportsRouter.get('/field/:fieldId/export.csv', requireCapability('reports.read'),
  validate(fieldCsvQuery, 'query'), asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.fieldId).success) {
      throw new HttpError(422, 'Identificador de lote inválido.');
    }
    let period;
    try {
      period = fieldCsvPeriod(req.query.from, req.query.to);
    } catch (error) {
      throw new HttpError(422, error.message);
    }
    const tx = req.dbTransaction;
    const field = await Field.findOne({
      where: { id: req.params.fieldId, tenant_id: req.tenantId },
      attributes: ['id', 'name', 'area_hectares'],
      include: [{ model: Farm, attributes: ['id', 'name'] }],
      transaction: tx
    });
    if (!field) throw new HttpError(404, 'Lote no encontrado.');
    const dateWhere = column => ({
      ...(period.start ? { [Op.gte]: period.start } : {}),
      ...(period.exclusiveEnd ? { [Op.lt]: period.exclusiveEnd } : {})
    });
    const observations = await ScoutingObservation.findAll({
      where: {
        tenant_id: req.tenantId, field_id: field.id,
        ...((period.start || period.exclusiveEnd)
          ? { observed_at: dateWhere('observed_at') } : {})
      },
      attributes: ['id', 'observed_at', 'observation_type', 'severity', 'notes'],
      order: [['observed_at', 'DESC'], ['id', 'DESC']],
      limit: FIELD_CSV_MAX_ROWS_PER_KIND + 1, transaction: tx
    });
    const orders = await WorkOrder.findAll({
      where: {
        tenant_id: req.tenantId, field_id: field.id,
        ...((period.start || period.exclusiveEnd)
          ? { created_at: dateWhere('created_at') } : {})
      },
      attributes: ['id', 'created_at', 'type', 'status', 'priority', 'title'],
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      limit: FIELD_CSV_MAX_ROWS_PER_KIND + 1, transaction: tx
    });
    if (observations.length > FIELD_CSV_MAX_ROWS_PER_KIND ||
        orders.length > FIELD_CSV_MAX_ROWS_PER_KIND) {
      throw new HttpError(413,
        'Demasiados registros para exportar. Elegí un período más corto.',
        undefined, 'REPORT_EXPORT_TOO_LARGE');
    }
    let csv;
    try {
      csv = buildFieldCsv({ field, observations, workOrders: orders });
    } catch (error) {
      throw new HttpError(413, error.message, undefined, 'REPORT_EXPORT_TOO_LARGE');
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: {
      filename: `reporte-lote-${field.id}.csv`, mimeType: 'text/csv;charset=utf-8',
      csv, counts: { observations: observations.length, workOrders: orders.length },
      period: { from: period.from, to: period.to }
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

