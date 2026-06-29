import { Router } from 'express';
import { z } from 'zod';
import { ReportRun, ReportTemplate } from '../../models/index.js';
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
