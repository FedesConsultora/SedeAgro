import { Router } from 'express';
import { z } from 'zod';
import {
  CampaignField,
  EvidenceAsset,
  Field,
  ScoutingObservation,
  ScoutingRun
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

export const scoutingRouter = Router();

scoutingRouter.use(requireEntitlement('scouting'));

const runSchema = z.object({
  campaign_field_id: z.string().uuid(),
  assigned_to: z.string().uuid().optional().nullable(),
  scheduled_at: z.coerce.date().optional(),
  status: z.enum(['planned', 'in_progress', 'completed', 'cancelled']).default('planned'),
  summary: z.string().optional()
});

const observationSchema = z.object({
  field_id: z.string().uuid(),
  observation_type: z.enum(['weed', 'pest', 'disease', 'phenology', 'nutrition', 'water', 'general']),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  point: z.any().optional(),
  notes: z.string().optional(),
  observed_at: z.coerce.date().optional()
});

const evidenceSchema = z.object({
  kind: z.enum(['photo', 'audio', 'document', 'video', 'other']),
  storage_key: z.string().min(3),
  original_name: z.string().max(240).optional(),
  mime_type: z.string().max(120).optional(),
  size_bytes: z.coerce.number().int().nonnegative().optional(),
  captured_at: z.coerce.date().optional(),
  point: z.any().optional()
});

scoutingRouter.get('/runs', asyncHandler(async (req, res) => {
  const runs = await ScoutingRun.findAll({
    include: [{ model: CampaignField, include: [{ model: Field, attributes: ['id', 'name'] }] }],
    order: [['scheduled_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: runs });
}));

scoutingRouter.post('/runs', validate(runSchema), asyncHandler(async (req, res) => {
  const run = await ScoutingRun.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: run });
}));

scoutingRouter.get('/runs/:id', asyncHandler(async (req, res) => {
  const run = await ScoutingRun.findByPk(req.params.id, {
    include: [
      { model: CampaignField, include: [{ model: Field }] },
      { model: ScoutingObservation, include: [{ model: EvidenceAsset }] }
    ],
    transaction: req.dbTransaction
  });
  if (!run) return res.status(404).json({ error: { message: 'Monitoreo no encontrado.' } });
  res.json({ data: run });
}));

scoutingRouter.post('/runs/:runId/observations', validate(observationSchema), asyncHandler(async (req, res) => {
  const observation = await ScoutingObservation.create({
    ...req.body,
    scouting_run_id: req.params.runId,
    observed_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: observation });
}));

scoutingRouter.post('/observations/:observationId/evidence', validate(evidenceSchema), asyncHandler(async (req, res) => {
  const evidence = await EvidenceAsset.create({
    ...req.body,
    scouting_observation_id: req.params.observationId,
    uploaded_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: evidence });
}));
