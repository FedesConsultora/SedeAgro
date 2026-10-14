import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  CampaignField, EvidenceAsset, EvidenceBlob, Field, Membership, User,
  ScoutingObservation, ScoutingRun
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { ASSIGNABLE_ROLES, assertRunAssignmentChange, assertRunReadyToStart, assertRunTransition, assertScoutingWritable, canReadScoutingRun } from './scoutingPolicy.js';
import { decodeEvidenceContent, safeEvidenceFileName } from './evidenceContent.js';

export const scoutingRouter = Router();
scoutingRouter.use(requireEntitlement('scouting'));

const pointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
}).strict();
const runSchema = z.object({
  campaign_field_id: z.string().uuid(),
  assigned_to: z.string().uuid().optional().nullable(),
  scheduled_at: z.coerce.date().optional(),
  status: z.enum(['planned', 'in_progress']).default('planned'),
  summary: z.string().max(5000).optional()
}).strict();
const updateRunSchema = z.object({
  assigned_to: z.string().uuid().nullable().optional(),
  scheduled_at: z.coerce.date().nullable().optional(),
  status: z.enum(['planned', 'in_progress', 'completed', 'cancelled']).optional(),
  summary: z.string().max(5000).nullable().optional()
}).strict();
const observationSchema = z.object({
  field_id: z.string().uuid().optional(), // accepted for older clients, never trusted
  observation_type: z.enum(['weed', 'pest', 'disease', 'phenology', 'nutrition', 'water', 'general']),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  point: pointSchema.optional(),
  notes: z.string().min(1).max(10000),
  observed_at: z.coerce.date().optional()
}).strict();
const evidenceSchema = z.object({
  kind: z.enum(['photo', 'document']),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  original_name: z.string().min(1).max(180),
  content_base64: z.string().min(1).max(2796204),
  captured_at: z.coerce.date().optional()
}).strict();

async function findRun(req, id, forUpdate = false) {
  const run = await ScoutingRun.findByPk(id, {
    transaction: req.dbTransaction,
    ...(forUpdate ? { lock: req.dbTransaction.LOCK.UPDATE } : {})
  });
  if (!run || !canReadScoutingRun(req.auth, run)) {
    throw new HttpError(404, 'Recorrida no encontrada.', undefined, 'SCOUTING_RUN_NOT_FOUND');
  }
  return run;
}

async function verifyAssignee(req, userId) {
  if (!userId) return;
  const member = await Membership.findOne({
    where: {
      tenant_id: req.tenantId,
      user_id: userId,
      status: 'active',
      role_code: ASSIGNABLE_ROLES
    },
    include: [{ model: User, attributes: ['id'], where: { status: 'active' }, required: true }],
    transaction: req.dbTransaction
  });
  if (!member) {
    throw new HttpError(422, 'Elegí un monitoreador o coordinador activo de esta empresa.',
      undefined, 'SCOUTING_ASSIGNEE_INVALID');
  }
}

scoutingRouter.get('/assignees', requireCapability('scouting.plan'), asyncHandler(async (req, res) => {
  const members = await Membership.findAll({
    where: { tenant_id: req.tenantId, status: 'active', role_code: ASSIGNABLE_ROLES },
    include: [{
      model: User, attributes: ['id', 'full_name'],
      where: { status: 'active' }, required: true
    }],
    order: [[User, 'full_name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: members.map((membership) => ({
    id: membership.user_id,
    name: membership.User.full_name,
    role_code: membership.role_code
  })) });
}));

scoutingRouter.get('/runs', requireCapability('scouting.read'), asyncHandler(async (req, res) => {
  const runs = await ScoutingRun.findAll({
    ...(req.auth.role.code === 'scout' ? { where: { assigned_to: req.auth.user.id } } : {}),
    include: [
      { model: CampaignField, include: [{ model: Field, attributes: ['id', 'name'] }] },
      { model: User, as: 'assignee', attributes: ['id', 'full_name'] }
    ],
    order: [['scheduled_at', 'DESC'], ['created_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: runs });
}));

scoutingRouter.post('/runs', requireCapability('scouting.plan'), validate(runSchema), asyncHandler(async (req, res) => {
  const campaignField = await CampaignField.findByPk(req.body.campaign_field_id, { transaction: req.dbTransaction });
  if (!campaignField) throw new HttpError(404, 'Lote de campaña no encontrado.');
  await verifyAssignee(req, req.body.assigned_to);
  if (req.body.status === 'in_progress') {
    assertRunReadyToStart(null, req.body.assigned_to);
  }
  const run = await ScoutingRun.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: run });
}));

scoutingRouter.get('/runs/:id', requireCapability('scouting.read'), asyncHandler(async (req, res) => {
  await findRun(req, req.params.id);
  const run = await ScoutingRun.findByPk(req.params.id, {
    include: [
      { model: CampaignField, include: [{ model: Field }] },
      { model: User, as: 'assignee', attributes: ['id', 'full_name'] },
      { model: ScoutingObservation, include: [{ model: EvidenceAsset }] }
    ],
    transaction: req.dbTransaction
  });
  res.json({ data: run });
}));

scoutingRouter.post('/runs/:runId/observations', requireCapability('scouting.observe'), validate(observationSchema), asyncHandler(async (req, res) => {
  const run = await findRun(req, req.params.runId, true);
  assertScoutingWritable(req.auth, run);
  const campaignField = await CampaignField.findByPk(run.campaign_field_id, { transaction: req.dbTransaction });
  if (!campaignField) throw new HttpError(409, 'La recorrida no tiene un lote válido.');
  if (req.body.field_id && req.body.field_id !== campaignField.field_id) {
    throw new HttpError(422, 'La observación debe pertenecer al lote de la recorrida.', undefined, 'SCOUTING_FIELD_MISMATCH');
  }
  const { field_id: _ignored, ...payload } = req.body;
  const observation = await ScoutingObservation.create({
    ...payload,
    field_id: campaignField.field_id,
    scouting_run_id: run.id,
    observed_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: observation });
}));

scoutingRouter.post('/observations/:observationId/evidence', requireCapability('scouting.evidence'), validate(evidenceSchema), asyncHandler(async (req, res) => {
  const observation = await ScoutingObservation.findByPk(req.params.observationId, { transaction: req.dbTransaction });
  if (!observation) throw new HttpError(404, 'Observación no encontrada.');
  const run = await findRun(req, observation.scouting_run_id, true);
  assertScoutingWritable(req.auth, run);
  const bytes = decodeEvidenceContent(req.body);
  const id = randomUUID();
  const evidence = await EvidenceAsset.create({
    id,
    scouting_observation_id: observation.id,
    uploaded_by: req.auth.user.id,
    kind: req.body.kind,
    storage_key: `db:${id}`,
    original_name: safeEvidenceFileName(req.body.original_name),
    mime_type: req.body.mime_type,
    size_bytes: bytes.length,
    captured_at: req.body.captured_at || new Date()
  }, { transaction: req.dbTransaction });
  await EvidenceBlob.create({
    tenant_id: req.tenantId,
    evidence_id: evidence.id,
    content: bytes
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: evidence });
}));

scoutingRouter.get('/evidence/:id/content', requireCapability('scouting.read'), asyncHandler(async (req, res) => {
  const evidence = await EvidenceAsset.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!evidence?.scouting_observation_id) throw new HttpError(404, 'Evidencia no encontrada.');
  const observation = await ScoutingObservation.findByPk(evidence.scouting_observation_id, { transaction: req.dbTransaction });
  if (!observation) throw new HttpError(404, 'Evidencia no encontrada.');
  await findRun(req, observation.scouting_run_id);
  const blob = await EvidenceBlob.findOne({
    where: { evidence_id: evidence.id, tenant_id: req.tenantId },
    transaction: req.dbTransaction
  });
  if (!blob) throw new HttpError(404, 'El archivo no está disponible; solo se registraron metadatos.');
  res.set('Cache-Control', 'private, no-store');
  res.json({ data: {
    id: evidence.id,
    original_name: evidence.original_name,
    mime_type: evidence.mime_type,
    size_bytes: evidence.size_bytes,
    content_base64: Buffer.from(blob.content).toString('base64')
  } });
}));

scoutingRouter.patch('/runs/:id', requireCapability('scouting.plan'), validate(updateRunSchema), asyncHandler(async (req, res) => {
  const run = await findRun(req, req.params.id, true);
  if (req.body.status) assertRunTransition(run.status, req.body.status);
  if (['completed', 'cancelled'].includes(run.status)) {
    throw new HttpError(409, 'No se puede modificar una recorrida cerrada.');
  }
  if (Object.hasOwn(req.body, 'assigned_to')) {
    assertRunAssignmentChange(run, req.body.assigned_to);
    await verifyAssignee(req, req.body.assigned_to);
  }
  if (req.body.status === 'in_progress' && run.status === 'planned') {
    const nextAssignee = Object.hasOwn(req.body, 'assigned_to') ?
      req.body.assigned_to : run.assigned_to;
    assertRunReadyToStart(run, nextAssignee);
    await verifyAssignee(req, nextAssignee);
  }
  const update = { ...req.body };
  if (req.body.status === 'completed') update.completed_at = new Date();
  await run.update(update, { transaction: req.dbTransaction });
  res.json({ data: run });
}));
