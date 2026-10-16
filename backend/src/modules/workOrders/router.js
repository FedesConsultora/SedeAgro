import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import {
  AgriculturalInput,
  AuditEvent,
  EvidenceAsset,
  CampaignField,
  Field,
  Machinery,
  Membership,
  User,
  WorkOrder,
  WorkOrderAssignee,
  WorkOrderExecution,
  WorkOrderInput,
  WorkOrderMachinery
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate, HttpError } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { canTransitionWorkOrder } from './workOrderPolicy.js';
import { canSubmitExecution, canReviewExecution, canCloseReviewedOrder, validExecutionWindow, MAX_EXECUTION_REPORTS } from './executionPolicy.js';
import { canAddWorkOrderAssignee, hasActiveWorkOrderExecutor, safeAuditRequestId } from './assignmentPolicy.js';
import { createAssignmentNotification } from '../notifications/assignmentNotifications.js';
import { ORDER_RECIPIENT_ROLES } from '../notifications/assignmentNotificationPolicy.js';
import { decodeEvidenceContent, safeEvidenceFileName } from '../scouting/evidenceContent.js';
import { putPrivateEvidence, getPrivateEvidenceByteLength, getBoundedPrivateEvidence } from '../scouting/evidenceStorage.js';
import { classifyEvidenceIntegrity, shouldReadEvidenceBytes } from '../scouting/evidenceIntegrity.js';
import { canAttachExecutionEvidence, sameExecutionUpload, visibleExecutionEvidence, EXECUTION_EVIDENCE_LIMIT, ORDER_EVIDENCE_LIMIT } from './executionEvidencePolicy.js';

export const workOrdersRouter = Router();

workOrdersRouter.use(requireEntitlement('work_orders'));

const workOrderSchema = z.object({
  campaign_field_id: z.string().uuid().optional().nullable(),
  field_id: z.string().uuid(),
  type: z.enum(['application', 'sowing', 'fertilization', 'harvest', 'irrigation', 'inspection', 'other']),
  status: z.literal('draft').optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  due_at: z.coerce.date().optional(),
  title: z.string().min(2).max(180),
  instructions: z.string().optional()
});

const statusSchema = z.object({
  status: z.enum(['draft', 'pending_approval', 'approved', 'assigned', 'in_progress', 'completed', 'cancelled'])
});

const assigneeSchema = z.object({
  user_id: z.string().uuid(),
  responsibility: z.string().max(80).default('executor')
});

const inputSchema = z.object({
  input_id: z.string().uuid(),
  dose: z.coerce.number().nonnegative().optional(),
  dose_unit: z.string().max(40).optional(),
  total_quantity: z.coerce.number().nonnegative().optional(),
  notes: z.string().optional()
});

const machinerySchema = z.object({
  machinery_id: z.string().uuid(),
  role: z.string().max(80).default('primary')
});

// Explicit ISO offsets: the server records authored time, not an inferred timezone.
const executionSchema = z.object({
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }),
  worked_area_hectares: z.number().finite().min(0.01).max(1000000)
    .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
      'Informá hectáreas con hasta dos decimales.'),
  result_summary: z.string().trim().min(10).max(2000)
}).strict();

const executionReviewSchema = z.object({
  decision: z.enum(['verified', 'rejected']),
  reason: z.string().trim().min(10).max(500).optional()
}).strict().superRefine((body, ctx) => {
  if (body.decision === 'rejected' && !body.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'El rechazo requiere una explicación.' });
  }
  if (body.decision === 'verified' && body.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'La revisión positiva no admite un motivo de rechazo.' });
  }
});

// Use the same MIME signatures and 2 MiB ceiling as private scouting files.
const executionEvidenceSchema = z.object({
  kind: z.enum(['photo', 'document']),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  original_name: z.string().min(1).max(180),
  client_upload_id: z.string().uuid(),
  content_base64: z.string().min(1).max(2796204)
}).strict();

async function readableWorkOrder(req, id, lock = false) {
  const order = await WorkOrder.findByPk(id, {
    transaction: req.dbTransaction,
    ...(lock ? { lock: req.dbTransaction.LOCK.UPDATE } : {})
  });
  if (!order || (req.auth.role.code === 'contractor' && !(await contractorAssignedToOrder(req, id)))) {
    throw new HttpError(404, 'Orden de trabajo no encontrada.', undefined, 'WORK_ORDER_NOT_FOUND');
  }
  return order;
}

async function privateExecutionAsset(req, orderId, assetId) {
  const asset = await EvidenceAsset.findOne({
    where: { tenant_id: req.tenantId, work_order_id: orderId, id: assetId,
      work_order_execution_id: { [Op.ne]: null } },
    transaction: req.dbTransaction
  });
  if (!asset) throw new HttpError(404, 'Adjunto de ejecución no encontrado.', undefined, 'ORDER_EVIDENCE_NOT_FOUND');
  return asset;
}

async function contractorAssignedToOrder(req, orderId) {
  return Boolean(await WorkOrderAssignee.findOne({
    where: { tenant_id: req.tenantId, work_order_id: orderId, user_id: req.auth.user.id },
    attributes: ['id'],
    transaction: req.dbTransaction
  }));
}

workOrdersRouter.get('/', requireCapability('orders.read'), asyncHandler(async (req, res) => {
  const contractor = req.auth.role.code === 'contractor';
  const assignments = contractor ? await WorkOrderAssignee.findAll({
    where: { tenant_id: req.tenantId, user_id: req.auth.user.id },
    attributes: ['work_order_id'],
    transaction: req.dbTransaction
  }) : [];
  const orders = await WorkOrder.findAll({
    ...(contractor ? { where: { id: { [Op.in]: assignments.map((item) => item.work_order_id) } } } : {}),
    include: [
      { model: Field, attributes: ['id', 'name', 'area_hectares'] },
      { model: CampaignField, attributes: ['id', 'campaign_id', 'crop_type_id'] },
      { model: WorkOrderAssignee },
      { model: WorkOrderInput, include: [{ model: AgriculturalInput, attributes: ['id', 'name', 'unit', 'category'] }] },
      { model: WorkOrderMachinery, include: [{ model: Machinery, attributes: ['id', 'name', 'kind', 'status'] }] }
    ],
    order: [['due_at', 'ASC'], ['created_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: orders });
}));

workOrdersRouter.post('/', requireCapability('orders.write'), validate(workOrderSchema), asyncHandler(async (req, res) => {
  const order = await WorkOrder.create({
    ...req.body,
    status: 'draft',
    requested_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: order });
}));

workOrdersRouter.get('/:id', requireCapability('orders.read'), asyncHandler(async (req, res) => {
  if (req.auth.role.code === 'contractor' && !(await contractorAssignedToOrder(req, req.params.id))) {
    return res.status(404).json({ error: { message: 'Orden de trabajo no encontrada.' } });
  }
  const order = await WorkOrder.findByPk(req.params.id, {
    include: [
      { model: Field },
      { model: CampaignField },
      { model: WorkOrderAssignee },
      { model: WorkOrderInput, include: [{ model: AgriculturalInput }] },
      { model: WorkOrderMachinery, include: [{ model: Machinery }] }
    ],
    transaction: req.dbTransaction
  });
  if (!order) return res.status(404).json({ error: { message: 'Orden de trabajo no encontrada.' } });
  const executions = await WorkOrderExecution.findAll({
    where: { tenant_id: req.tenantId, work_order_id: order.id },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: MAX_EXECUTION_REPORTS,
    transaction: req.dbTransaction
  });
  res.json({ data: { ...order.toJSON(), WorkOrderExecutions: executions } });
}));

workOrdersRouter.patch('/:id/status', requireCapability('orders.execute'), validate(statusSchema), asyncHandler(async (req, res) => {
  const order = await WorkOrder.findByPk(req.params.id, {
    transaction: req.dbTransaction,
    lock: req.dbTransaction.LOCK.UPDATE
  });
  if (!order) return res.status(404).json({ error: { message: 'Orden de trabajo no encontrada.' } });

  const roleCode = req.auth.role.code;
  const assigned = roleCode === 'contractor'
    ? await contractorAssignedToOrder(req, order.id)
    : false;
  const nextStatus = req.body.status;
  if (!canTransitionWorkOrder(order.status, nextStatus, roleCode, assigned)) {
    throw new HttpError(roleCode === 'contractor' ? 403 : 409,
      'Transición de orden no permitida para este usuario o estado.',
      undefined, 'WORK_ORDER_TRANSITION_DENIED');
  }
  if (nextStatus === 'completed') {
    const reports = await WorkOrderExecution.findAll({
      where: { tenant_id: req.tenantId, work_order_id: order.id, review_status: 'verified' },
      attributes: ['id', 'review_status'],
      limit: 1, transaction: req.dbTransaction
    });
    if (!canCloseReviewedOrder(roleCode, reports)) {
      throw new HttpError(roleCode === 'contractor' ? 403 : 409,
        'El cierre requiere un parte de ejecución verificado y autorización de coordinación.',
        undefined, 'WORK_ORDER_EXECUTION_REVIEW_REQUIRED');
    }
  }
  if (nextStatus === 'assigned') {
    const assignees = await WorkOrderAssignee.findAll({
      where: { tenant_id: req.tenantId, work_order_id: order.id },
      attributes: ['user_id'],
      transaction: req.dbTransaction
    });
    const userIds = assignees.map(item => item.user_id);
    const memberships = userIds.length ? await Membership.findAll({
      where: {
        tenant_id: req.tenantId,
        user_id: { [Op.in]: userIds },
        status: 'active',
        role_code: { [Op.in]: ORDER_RECIPIENT_ROLES }
      },
      attributes: ['user_id'],
      include: [{
        model: User,
        attributes: ['id'],
        where: { status: 'active' },
        required: true
      }],
      transaction: req.dbTransaction
    }) : [];
    if (!hasActiveWorkOrderExecutor(userIds, memberships.map(item => item.user_id))) {
      throw new HttpError(409,
        'La orden necesita al menos un responsable activo para pasar a asignada.',
        undefined, 'WORK_ORDER_ACTIVE_ASSIGNEE_REQUIRED');
    }
  }
  const previousStatus = order.status;
  await order.update({
    status: nextStatus,
    approved_at: nextStatus === 'approved' ? new Date() : order.approved_at,
    completed_at: nextStatus === 'completed' ? new Date() : order.completed_at
  }, { transaction: req.dbTransaction });
  await AuditEvent.create({
    tenant_id: req.tenantId,
    actor_id: req.auth.user.id,
    action: 'work_order.status_changed',
    entity_type: 'work_order',
    entity_id: order.id,
    before: { status: previousStatus },
    after: { status: nextStatus },
    request_id: safeAuditRequestId(req.requestId)
  }, { transaction: req.dbTransaction });

  res.json({ data: order });
}));

workOrdersRouter.post('/:id/executions', requireCapability('orders.execute'), validate(executionSchema), asyncHandler(async (req, res) => {
  const order = await WorkOrder.findByPk(req.params.id, {
    transaction: req.dbTransaction, lock: req.dbTransaction.LOCK.UPDATE
  });
  if (!order) throw new HttpError(404, 'Orden no encontrada.');
  const roleCode = req.auth.role.code;
  const assigned = roleCode === 'contractor' && await contractorAssignedToOrder(req, order.id);
  if (!canSubmitExecution(roleCode, assigned)) {
    throw new HttpError(403, 'No tenés asignación vigente para informar este trabajo.',
      undefined, 'EXECUTION_SUBMISSION_DENIED');
  }
  if (order.status !== 'in_progress') {
    throw new HttpError(409, 'Solo se puede declarar ejecución en una orden en curso.',
      undefined, 'WORK_ORDER_NOT_IN_PROGRESS');
  }
  const started = new Date(req.body.started_at);
  const finished = new Date(req.body.finished_at);
  if (!validExecutionWindow(started, finished, order.approved_at)) {
    throw new HttpError(422, 'El intervalo debe estar dentro de la orden aprobada, sin fechas futuras.',
      undefined, 'EXECUTION_TIME_INVALID');
  }
  const active = await WorkOrderExecution.findOne({
    where: { tenant_id: req.tenantId, work_order_id: order.id,
      review_status: { [Op.in]: ['submitted', 'verified'] } },
    transaction: req.dbTransaction
  });
  if (active) {
    throw new HttpError(409, 'Ya existe una declaración pendiente o verificada. Actualizá el detalle.',
      undefined, 'EXECUTION_ALREADY_SUBMITTED');
  }
  const count = await WorkOrderExecution.count({
    where: { tenant_id: req.tenantId, work_order_id: order.id },
    transaction: req.dbTransaction
  });
  if (count >= MAX_EXECUTION_REPORTS) {
    throw new HttpError(409, 'La orden alcanzó el máximo de revisiones; contactá a coordinación.',
      undefined, 'EXECUTION_REPORT_LIMIT');
  }
  const report = await WorkOrderExecution.create({
    tenant_id: req.tenantId,
    work_order_id: order.id,
    submitted_by: req.auth.user.id,
    started_at: started,
    finished_at: finished,
    worked_area_hectares: req.body.worked_area_hectares,
    result_summary: req.body.result_summary,
    review_status: 'submitted'
  }, { transaction: req.dbTransaction });
  await AuditEvent.create({
    tenant_id: req.tenantId, actor_id: req.auth.user.id,
    action: 'work_order.execution_submitted', entity_type: 'work_order',
    entity_id: order.id, after: { execution_id: report.id, review_status: 'submitted' },
    request_id: safeAuditRequestId(req.requestId)
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: report });
}));

workOrdersRouter.post('/:id/executions/:executionId/review', requireCapability('orders.write'),
  validate(executionReviewSchema), asyncHandler(async (req, res) => {
  const order = await WorkOrder.findByPk(req.params.id, {
    transaction: req.dbTransaction, lock: req.dbTransaction.LOCK.UPDATE
  });
  if (!order) throw new HttpError(404, 'Orden no encontrada.');
  const roleCode = req.auth.role.code;
  if (!['tenant_admin', 'agronomic_coordinator'].includes(roleCode)) {
    throw new HttpError(403, 'Solo coordinación puede revisar ejecuciones.');
  }
  if (order.status !== 'in_progress') {
    throw new HttpError(409, 'La orden ya no admite revisiones de ejecución.',
      undefined, 'EXECUTION_REVIEW_CLOSED');
  }
  const report = await WorkOrderExecution.findOne({
    where: { tenant_id: req.tenantId, work_order_id: order.id, id: req.params.executionId },
    transaction: req.dbTransaction, lock: req.dbTransaction.LOCK.UPDATE
  });
  if (!report) throw new HttpError(404, 'Parte de ejecución no encontrado.');
  if (!canReviewExecution(roleCode, req.auth.user.id, report.submitted_by)) {
    throw new HttpError(403, 'No podés revisar una declaración propia.',
      undefined, 'EXECUTION_SELF_REVIEW_DENIED');
  }
  if (report.review_status !== 'submitted') {
    throw new HttpError(409, 'Esta declaración ya fue revisada.',
      undefined, 'EXECUTION_ALREADY_REVIEWED');
  }
  await report.update({
    review_status: req.body.decision,
    reviewed_by: req.auth.user.id,
    reviewed_at: new Date(),
    review_note: req.body.decision === 'rejected' ? req.body.reason : null
  }, { transaction: req.dbTransaction });
  await AuditEvent.create({
    tenant_id: req.tenantId, actor_id: req.auth.user.id,
    action: 'work_order.execution_reviewed', entity_type: 'work_order',
    entity_id: order.id, before: { execution_id: report.id, review_status: 'submitted' },
    after: { execution_id: report.id, review_status: report.review_status },
    request_id: safeAuditRequestId(req.requestId)
  }, { transaction: req.dbTransaction });
  res.json({ data: report });
}));

// A single bounded metadata read avoids one request per report, and never
// returns BYTEA, digest, location, raw storage keys, or unrelated scouting assets.
workOrdersRouter.get('/:id/execution-evidence', requireCapability('orders.read'), asyncHandler(async (req, res) => {
  const order = await readableWorkOrder(req, req.params.id);
  const assets = await EvidenceAsset.findAll({
    where: { tenant_id: req.tenantId, work_order_id: order.id,
      work_order_execution_id: { [Op.ne]: null } },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: ORDER_EVIDENCE_LIMIT,
    transaction: req.dbTransaction
  });
  res.set('Cache-Control', 'private, no-store');
  res.json({ data: assets.map(visibleExecutionEvidence) });
}));

workOrdersRouter.post('/:id/executions/:executionId/evidence', requireCapability('orders.execute'),
  validate(executionEvidenceSchema), asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id, true);
    const report = await WorkOrderExecution.findOne({
      where: { tenant_id: req.tenantId, work_order_id: order.id, id: req.params.executionId },
      transaction: req.dbTransaction
    });
    if (!report) throw new HttpError(404, 'Parte de ejecución no encontrado.', undefined, 'EXECUTION_NOT_FOUND');
    // Both the original author and the tenant membership must still be active.
    if (report.submitted_by !== req.auth.user.id) {
      throw new HttpError(403, 'Solo quien presentó el parte puede adjuntar sus respaldos.',
        undefined, 'ORDER_EVIDENCE_AUTHOR_REQUIRED');
    }
    const bytes = decodeEvidenceContent(req.body);
    const originalName = safeEvidenceFileName(req.body.original_name);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const where = { tenant_id: req.tenantId, uploaded_by: req.auth.user.id,
      client_upload_id: req.body.client_upload_id };
    // Preserve exact replay after a successful upload even if the report was
    // reviewed or the order closed. Never let UUID reuse attach different bytes.
    const previous = await EvidenceAsset.findOne({ where, transaction: req.dbTransaction });
    const identity = { orderId: order.id, executionId: report.id, digest,
      kind: req.body.kind, mimeType: req.body.mime_type, originalName };
    if (previous) {
      if (!sameExecutionUpload(previous, identity)) {
        throw new HttpError(409, 'La clave de carga ya se utilizó con otro archivo.',
          undefined, 'ORDER_EVIDENCE_UPLOAD_CONFLICT');
      }
      res.set('Cache-Control', 'private, no-store');
      res.json({ data: visibleExecutionEvidence(previous), replayed: true });
      return;
    }
    const count = await EvidenceAsset.count({
      where: { tenant_id: req.tenantId, work_order_id: order.id, work_order_execution_id: report.id },
      transaction: req.dbTransaction
    });
    if (!canAttachExecutionEvidence({ orderStatus: order.status,
      reviewStatus: report.review_status, uploaderId: req.auth.user.id,
      submitterId: report.submitted_by, count })) {
      throw new HttpError(409, 'El parte debe estar pendiente de revisión y admitir nuevos adjuntos.',
        undefined, 'ORDER_EVIDENCE_UPLOAD_CLOSED');
    }
    const id = randomUUID();
    const attrs = { id, tenant_id: req.tenantId, work_order_id: order.id,
      work_order_execution_id: report.id, uploaded_by: req.auth.user.id,
      client_upload_id: req.body.client_upload_id, content_sha256: digest,
      storage_key: `db:${id}`, original_name: originalName,
      kind: req.body.kind, mime_type: req.body.mime_type, size_bytes: bytes.length };
    // Savepoint handles concurrent/retried IDs without leaking duplicate blobs.
    const [asset, created] = await EvidenceAsset.findOrCreate({
      where, defaults: attrs, transaction: req.dbTransaction
    });
    if (!created) {
      if (!sameExecutionUpload(asset, identity)) {
        throw new HttpError(409, 'La clave de carga ya se utilizó con otro archivo.',
          undefined, 'ORDER_EVIDENCE_UPLOAD_CONFLICT');
      }
      res.set('Cache-Control', 'private, no-store');
      res.json({ data: visibleExecutionEvidence(asset), replayed: true });
      return;
    }
    await putPrivateEvidence({ tenantId: req.tenantId, evidenceId: asset.id,
      bytes, transaction: req.dbTransaction });
    await AuditEvent.create({
      tenant_id: req.tenantId, actor_id: req.auth.user.id,
      action: 'work_order.execution_evidence_uploaded', entity_type: 'work_order',
      entity_id: order.id,
      after: { execution_id: report.id, evidence_id: asset.id,
        kind: asset.kind, size_bytes: asset.size_bytes },
      request_id: safeAuditRequestId(req.requestId)
    }, { transaction: req.dbTransaction });
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json({ data: visibleExecutionEvidence(asset), replayed: false });
  }));

workOrdersRouter.get('/:id/evidence/:evidenceId/integrity', requireCapability('orders.read'),
  asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id);
    const asset = await privateExecutionAsset(req, order.id, req.params.evidenceId);
    const length = await getPrivateEvidenceByteLength({ tenantId: req.tenantId,
      evidenceId: asset.id, transaction: req.dbTransaction });
    const bytes = shouldReadEvidenceBytes(asset.content_sha256, asset.size_bytes, length)
      ? await getBoundedPrivateEvidence({ tenantId: req.tenantId,
        evidenceId: asset.id, transaction: req.dbTransaction })
      : undefined;
    const status = classifyEvidenceIntegrity({
      expectedHash: asset.content_sha256, declaredSize: asset.size_bytes,
      blobLength: length, bytes
    });
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: { id: asset.id, status } });
  }));

workOrdersRouter.get('/:id/evidence/:evidenceId/content', requireCapability('orders.read'),
  asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id);
    const asset = await privateExecutionAsset(req, order.id, req.params.evidenceId);
    const length = await getPrivateEvidenceByteLength({ tenantId: req.tenantId,
      evidenceId: asset.id, transaction: req.dbTransaction });
    if (length === null) throw new HttpError(404, 'El archivo privado no está disponible.',
      undefined, 'ORDER_EVIDENCE_BYTES_MISSING');
    const bytes = shouldReadEvidenceBytes(asset.content_sha256, asset.size_bytes, length)
      ? await getBoundedPrivateEvidence({ tenantId: req.tenantId,
        evidenceId: asset.id, transaction: req.dbTransaction })
      : undefined;
    if (classifyEvidenceIntegrity({ expectedHash: asset.content_sha256,
      declaredSize: asset.size_bytes, blobLength: length, bytes }) !== 'verified') {
      throw new HttpError(409, 'Falló la comprobación de integridad del archivo.',
        undefined, 'ORDER_EVIDENCE_INTEGRITY_FAILED');
    }
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.json({ data: { id: asset.id, original_name: asset.original_name,
      mime_type: asset.mime_type, size_bytes: asset.size_bytes,
      content_base64: bytes.toString('base64') } });
  }));

workOrdersRouter.post('/:id/assignees', requireCapability('orders.write'), validate(assigneeSchema), asyncHandler(async (req, res) => {
  // Serialize concurrent assignments for one order before checking membership
  // or writing the relationship. With the unique DB key, replays cannot
  // produce a second assignee or a second notification.
  const order = await WorkOrder.findByPk(req.params.id, {
    transaction: req.dbTransaction,
    lock: req.dbTransaction.LOCK.UPDATE
  });
  if (!order) throw new HttpError(404, 'Orden de trabajo no encontrada.');
  if (!canAddWorkOrderAssignee(order.status)) {
    throw new HttpError(409, 'No se pueden incorporar responsables después de iniciar la asignación operativa.',
      undefined, 'WORK_ORDER_ASSIGNMENT_CLOSED');
  }

  const membership = await Membership.findOne({
    where: {
      tenant_id: req.tenantId,
      user_id: req.body.user_id,
      status: 'active',
      role_code: { [Op.in]: ORDER_RECIPIENT_ROLES }
    },
    include: [{
      model: User,
      attributes: ['id'],
      where: { status: 'active' },
      required: true
    }],
    transaction: req.dbTransaction
  });
  if (!membership) {
    throw new HttpError(422, 'El responsable debe ser un usuario activo con acceso a órdenes de esta organización.');
  }

  const [assignee, created] = await WorkOrderAssignee.findOrCreate({
    where: {
      tenant_id: req.tenantId,
      work_order_id: order.id,
      user_id: req.body.user_id
    },
    defaults: { responsibility: req.body.responsibility },
    transaction: req.dbTransaction
  });
  if (!created && assignee.responsibility !== req.body.responsibility) {
    throw new HttpError(409, 'El responsable ya tiene otra función en esta orden.');
  }
  if (created) {
    await createAssignmentNotification(req, {
      entityType: 'work_order', entityId: order.id, userId: assignee.user_id
    });
    await AuditEvent.create({
      tenant_id: req.tenantId,
      actor_id: req.auth.user.id,
      action: 'work_order.assignee_added',
      entity_type: 'work_order',
      entity_id: order.id,
      after: { user_id: assignee.user_id },
      request_id: safeAuditRequestId(req.requestId)
    }, { transaction: req.dbTransaction });
  }
  res.status(created ? 201 : 200).json({ data: assignee, replayed: !created });
}));

workOrdersRouter.post('/:id/inputs', requireCapability('orders.write'), validate(inputSchema), asyncHandler(async (req, res) => {
  const input = await WorkOrderInput.create({
    ...req.body,
    work_order_id: req.params.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: input });
}));

workOrdersRouter.post('/:id/machinery', requireCapability('orders.write'), validate(machinerySchema), asyncHandler(async (req, res) => {
  const machine = await WorkOrderMachinery.create({
    ...req.body,
    work_order_id: req.params.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: machine });
}));
