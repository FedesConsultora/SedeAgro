import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import {
  AuditEvent, CampaignField, EvidenceAsset, EvidenceBlob, Field, Membership, User,
  ScoutingObservation, ScoutingRun
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { ASSIGNABLE_ROLES, assertRunAssignmentChange, assertRunReadyToStart, assertRunTransition, assertScoutingWritable, canReadScoutingRun } from './scoutingPolicy.js';
import { decodeEvidenceContent, safeEvidenceFileName } from './evidenceContent.js';
import { putPrivateEvidence,
  getPrivateEvidenceByteLength, getBoundedPrivateEvidence } from './evidenceStorage.js';
import { classifyEvidenceIntegrity, shouldReadEvidenceBytes } from './evidenceIntegrity.js';
import { evidenceProvenanceView } from './evidenceProvenance.js';
import { encodeEvidencePageCursor, parseEvidencePageQuery } from './evidencePagination.js';
import { recordScoutingAudit } from './audit.js';
import { createAssignmentNotification } from '../notifications/assignmentNotifications.js';
import { shouldNotifyRunAssignment } from '../notifications/assignmentNotificationPolicy.js';
import { reserveScoutingRunCreate, completeScoutingRunCreate } from './runCreateIdempotency.js';

export const scoutingRouter = Router();
scoutingRouter.use(requireEntitlement('scouting'));

const pointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
}).strict();
const runSchema = z.object({
  client_request_id: z.string().uuid().optional(),
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
const advanceStatusSchema = z.object({
  status: z.enum(['in_progress', 'completed'])
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
  client_upload_id: z.string().uuid().optional(),
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
  // A durable receipt is reserved before any side effects. A previously
  // committed request can be replayed only by the same currently authorized
  // actor. Its immutable payload hash is checked against the original input.
  const reservation = await reserveScoutingRunCreate(req, req.body);
  res.set('Cache-Control', 'private, no-store');
  if (reservation.kind === 'replay') {
    return res.status(200).json({ data: reservation.run, replayed: true });
  }
  const campaignField = await CampaignField.findByPk(req.body.campaign_field_id, { transaction: req.dbTransaction });
  if (!campaignField) throw new HttpError(404, 'Lote de campaña no encontrado.');
  await verifyAssignee(req, req.body.assigned_to);
  if (req.body.status === 'in_progress') {
    assertRunReadyToStart(null, req.body.assigned_to);
  }
  const { client_request_id: _clientRequestId, ...runInput } = req.body;
  const run = await ScoutingRun.create(runInput, { transaction: req.dbTransaction });
  await completeScoutingRunCreate(req, reservation, run.id);
  if (shouldNotifyRunAssignment(null, run.assigned_to)) {
    await createAssignmentNotification(req, {
      entityType: 'scouting_run', entityId: run.id, userId: run.assigned_to
    });
  }
  await recordScoutingAudit(req, {
    runId: run.id,
    action: 'scouting.run.created',
    after: { status: run.status, assigned_to: run.assigned_to, campaign_field_id: run.campaign_field_id }
  });
  res.status(201).json({ data: run, ...(reservation.kind === 'new' ? { replayed: false } : {}) });
}));

scoutingRouter.get('/runs/:id/audit', requireCapability('scouting.audit.read'), asyncHandler(async (req, res) => {
  const run = await ScoutingRun.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!run) throw new HttpError(404, 'Recorrida no encontrada.');
  const events = await AuditEvent.findAll({
    where: { entity_type: 'scouting_run', entity_id: run.id },
    attributes: ['id', 'actor_id', 'action', 'before', 'after', 'request_id', 'created_at'],
    order: [['created_at', 'DESC']],
    limit: 100,
    transaction: req.dbTransaction
  });
  res.json({ data: events });
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

// A separate read-only proof of presence: no private bytes and no filename,
// original notes, coordinates or content hashes are returned. Only current
// run readers can query it, with FORCE RLS still applying to both tables.
scoutingRouter.get('/runs/:id/evidence-status', requireCapability('scouting.read'), asyncHandler(async (req, res) => {
  const run = await findRun(req, req.params.id);
  const page = parseEvidencePageQuery(req.query, { tenantId: req.tenantId, runId: run.id });
  const after = page.after ? { [Op.or]: [
    { created_at: { [Op.lt]: page.after.date } },
    { created_at: page.after.date, id: { [Op.lt]: page.after.id } }
  ] } : {};
  const assets = await EvidenceAsset.findAll({
    attributes: ['id', 'scouting_observation_id', 'uploaded_by', 'client_upload_id',
      'kind', 'mime_type', 'size_bytes', 'captured_at', 'created_at'],
    where: { tenant_id: req.tenantId, ...after },
    include: [{
      model: ScoutingObservation, attributes: [], required: true,
      where: { tenant_id: req.tenantId, scouting_run_id: run.id }
    }],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: page.limit + 1,
    transaction: req.dbTransaction
  });
  const visible = assets.slice(0, page.limit);
  const ids = visible.map(item => item.id);
  const blobs = ids.length ? await EvidenceBlob.findAll({
    attributes: ['evidence_id'],
    where: { tenant_id: req.tenantId, evidence_id: { [Op.in]: ids } },
    transaction: req.dbTransaction
  }) : [];
  const nextCursor = assets.length > page.limit && visible.length
    ? encodeEvidencePageCursor(visible[visible.length - 1], {
      tenantId: req.tenantId, runId: run.id, limit: page.limit
    })
    : null;
  const result = evidenceProvenanceView(
    assets.map(item => item.get({ plain: true })),
    blobs.map(item => item.evidence_id),
    run.id, { limit: page.limit, nextCursor }
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({ data: result });
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
  await recordScoutingAudit(req, {
    runId: run.id,
    action: 'scouting.observation.created',
    after: {
      observation_id: observation.id,
      field_id: observation.field_id,
      observation_type: observation.observation_type,
      severity: observation.severity
    }
  });
  res.status(201).json({ data: observation });
}));

scoutingRouter.post('/observations/:observationId/evidence', requireCapability('scouting.evidence'), validate(evidenceSchema), asyncHandler(async (req, res) => {
  const observation = await ScoutingObservation.findByPk(req.params.observationId, { transaction: req.dbTransaction });
  if (!observation) throw new HttpError(404, 'Observación no encontrada.');
  // Lock the run before checking upload state. Close/reassign and both uploads
  // acquire this lock, avoiding a stale permission or status decision.
  const run = await findRun(req, observation.scouting_run_id, true);
  const bytes = decodeEvidenceContent(req.body);
  const originalName = safeEvidenceFileName(req.body.original_name);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const uploadId = req.body.client_upload_id || null;
  const where = {
    tenant_id: req.tenantId,
    uploaded_by: req.auth.user.id,
    client_upload_id: uploadId
  };

  // Replay of an already committed upload succeeds even if the run closed
  // subsequently, but only while the actor can still read the run.
  if (uploadId) {
    const previous = await EvidenceAsset.findOne({
      where,
      transaction: req.dbTransaction
    });
    if (previous) {
      if (previous.scouting_observation_id !== observation.id ||
          previous.content_sha256 !== digest ||
          previous.kind !== req.body.kind ||
          previous.mime_type !== req.body.mime_type ||
          previous.original_name !== originalName) {
        throw new HttpError(409, 'Esta clave de carga ya fue usada con otro archivo.',
          undefined, 'EVIDENCE_UPLOAD_CONFLICT');
      }
      res.json({ data: previous, replayed: true });
      return;
    }
  }

  assertScoutingWritable(req.auth, run);
  const id = randomUUID();
  const attrs = {
    id,
    scouting_observation_id: observation.id,
    uploaded_by: req.auth.user.id,
    kind: req.body.kind,
    client_upload_id: uploadId,
    content_sha256: digest,
    storage_key: `db:${id}`,
    original_name: originalName,
    mime_type: req.body.mime_type,
    size_bytes: bytes.length,
    captured_at: req.body.captured_at || new Date()
  };
  let evidence;
  let created = true;
  if (uploadId) {
    // Sequelize findOrCreate uses a savepoint when a transaction is supplied.
    // A racing second tab cannot duplicate the asset after the unique index
    // rejects its insert, and can safely inspect the winning row.
    [evidence, created] = await EvidenceAsset.findOrCreate({
      where,
      defaults: attrs,
      transaction: req.dbTransaction
    });
  } else {
    evidence = await EvidenceAsset.create(attrs, { transaction: req.dbTransaction });
  }
  if (!created) {
    if (evidence.scouting_observation_id !== observation.id ||
        evidence.content_sha256 !== digest ||
        evidence.kind !== req.body.kind ||
        evidence.mime_type !== req.body.mime_type ||
        evidence.original_name !== originalName) {
      throw new HttpError(409, 'Esta clave de carga ya fue usada con otro archivo.',
        undefined, 'EVIDENCE_UPLOAD_CONFLICT');
    }
    res.json({ data: evidence, replayed: true });
    return;
  }
  await putPrivateEvidence({
    tenantId: req.tenantId,
    evidenceId: evidence.id,
    bytes,
    transaction: req.dbTransaction
  });
  await recordScoutingAudit(req, {
    runId: run.id,
    action: 'scouting.evidence.uploaded',
    after: {
      evidence_id: evidence.id,
      observation_id: observation.id,
      kind: evidence.kind,
      mime_type: evidence.mime_type,
      size_bytes: evidence.size_bytes
    }
  });
  res.status(201).json({ data: evidence, replayed: false });
}));

// Explicit, one-asset-at-a-time verification. Its public response contains
// only an enum; no digest, bytea, original name or observation details.
scoutingRouter.get('/evidence/:id/integrity', requireCapability('scouting.read'), asyncHandler(async (req, res) => {
  const evidence = await EvidenceAsset.findOne({
    where: { id: req.params.id, tenant_id: req.tenantId },
    attributes: ['id', 'scouting_observation_id', 'content_sha256', 'size_bytes'],
    transaction: req.dbTransaction
  });
  if (!evidence?.scouting_observation_id) throw new HttpError(404, 'Evidencia no encontrada.');
  const observation = await ScoutingObservation.findOne({
    where: { id: evidence.scouting_observation_id, tenant_id: req.tenantId },
    attributes: ['scouting_run_id'],
    transaction: req.dbTransaction
  });
  if (!observation) throw new HttpError(404, 'Evidencia no encontrada.');
  await findRun(req, observation.scouting_run_id);

  const blobLength = await getPrivateEvidenceByteLength({
    tenantId: req.tenantId, evidenceId: evidence.id, transaction: req.dbTransaction
  });
  const bytes = shouldReadEvidenceBytes(
    evidence.content_sha256, evidence.size_bytes, blobLength
  ) ? await getBoundedPrivateEvidence({
      tenantId: req.tenantId, evidenceId: evidence.id, transaction: req.dbTransaction
    }) : undefined;
  const status = classifyEvidenceIntegrity({
    expectedHash: evidence.content_sha256,
    declaredSize: evidence.size_bytes,
    blobLength,
    bytes
  });
  res.set('Cache-Control', 'private, no-store');
  res.json({ data: { id: evidence.id, status } });
}));

scoutingRouter.get('/evidence/:id/content', requireCapability('scouting.read'), asyncHandler(async (req, res) => {
  const evidence = await EvidenceAsset.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!evidence?.scouting_observation_id) throw new HttpError(404, 'Evidencia no encontrada.');
  const observation = await ScoutingObservation.findByPk(evidence.scouting_observation_id, { transaction: req.dbTransaction });
  if (!observation) throw new HttpError(404, 'Evidencia no encontrada.');
  await findRun(req, observation.scouting_run_id);
  // Match the work-order private download contract: never present stored
  // bytes as evidence unless their persisted size and SHA-256 match exactly.
  // Probe the BYTEA size without transferring data to Node, then use a
  // database-bounded second read; the checks are in the same RLS transaction.
  const blobLength = await getPrivateEvidenceByteLength({
    tenantId: req.tenantId, evidenceId: evidence.id, transaction: req.dbTransaction
  });
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (blobLength === null) {
    throw new HttpError(404, 'El archivo privado no está disponible.', undefined,
      'SCOUTING_EVIDENCE_BYTES_MISSING');
  }
  const bytes = shouldReadEvidenceBytes(evidence.content_sha256, evidence.size_bytes, blobLength)
    ? await getBoundedPrivateEvidence({
      tenantId: req.tenantId, evidenceId: evidence.id, transaction: req.dbTransaction
    }) : undefined;
  const integrity = classifyEvidenceIntegrity({
    expectedHash: evidence.content_sha256,
    declaredSize: evidence.size_bytes,
    blobLength, bytes
  });
  if (integrity !== 'verified') {
    throw new HttpError(409, 'Falló la comprobación de integridad del archivo privado.',
      undefined, 'SCOUTING_EVIDENCE_INTEGRITY_FAILED');
  }
  res.json({ data: {
    id: evidence.id,
    original_name: evidence.original_name,
    mime_type: evidence.mime_type,
    size_bytes: evidence.size_bytes,
    content_base64: bytes.toString('base64')
  } });
}));

// Assigned field operators can advance only their own runs. Planning, cancellation
// and assignment remain limited to administrative/coordinator capabilities.
scoutingRouter.patch('/runs/:id/status', requireCapability('scouting.observe'), validate(advanceStatusSchema),
  asyncHandler(async (req, res) => {
    const run = await findRun(req, req.params.id, true);
    assertRunTransition(run.status, req.body.status);
    if (req.body.status === 'in_progress') {
      assertRunReadyToStart(run, run.assigned_to);
      await verifyAssignee(req, run.assigned_to);
    }
    const oldStatus = run.status;
    await run.update({
      status: req.body.status,
      ...(req.body.status === 'completed' ? { completed_at: new Date() } : {})
    }, { transaction: req.dbTransaction });
    if (oldStatus !== run.status) {
      await recordScoutingAudit(req, {
        runId: run.id,
        action: 'scouting.run.status_changed',
        before: { status: oldStatus },
        after: { status: run.status }
      });
    }
    res.json({ data: run });
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
  const previous = {
    status: run.status,
    assigned_to: run.assigned_to,
    scheduled_at: run.scheduled_at
  };
  const update = { ...req.body };
  if (req.body.status === 'completed') update.completed_at = new Date();
  await run.update(update, { transaction: req.dbTransaction });
  if (shouldNotifyRunAssignment(previous.assigned_to, run.assigned_to)) {
    await createAssignmentNotification(req, {
      entityType: 'scouting_run', entityId: run.id, userId: run.assigned_to
    });
  }
  await recordScoutingAudit(req, {
    runId: run.id,
    action: 'scouting.run.updated',
    before: previous,
    after: {
      status: run.status,
      assigned_to: run.assigned_to,
      scheduled_at: run.scheduled_at
    }
  });
  res.json({ data: run });
}));
