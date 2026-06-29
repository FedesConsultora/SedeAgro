import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import {
  ReportRun, ReportTemplate,
  Field, Farm, CampaignField, Campaign, CropType,
  ScoutingRun, ScoutingObservation, WorkOrder
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

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

reportsRouter.get('/templates', asyncHandler(async (req, res) => {
  const templates = await ReportTemplate.findAll({
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: templates });
}));

reportsRouter.post('/templates', validate(templateSchema), asyncHandler(async (req, res) => {
  const template = await ReportTemplate.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: template });
}));

reportsRouter.get('/runs', asyncHandler(async (req, res) => {
  const runs = await ReportRun.findAll({
    include: [{ model: ReportTemplate, attributes: ['id', 'name', 'code', 'format'] }],
    order: [['created_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: runs });
}));

reportsRouter.post('/runs', validate(runSchema), asyncHandler(async (req, res) => {
  const run = await ReportRun.create({
    ...req.body,
    requested_by: req.auth.user.id,
    status: 'queued'
  }, { transaction: req.dbTransaction });
  res.status(202).json({ data: run });
}));

// ─── Field-level report ───────────────────────────────────────
reportsRouter.get('/field/:fieldId', asyncHandler(async (req, res) => {
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

