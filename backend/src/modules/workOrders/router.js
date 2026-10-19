import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { Op, fn, col, where, literal, QueryTypes } from 'sequelize';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
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
  WorkOrderExecutionException,
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
import { canAcceptReviewChecklist } from './reviewChecklistPolicy.js';
import { buildInputDeclaration, sameInputDeclaration, hasRequiredInputDeclaration, MAX_DECLARED_INPUTS } from './inputDeclarationPolicy.js';
import { positiveDeclaredQuantity, sameUnplannedRequest, canApproveWithExceptions,
  canReviewException, publicException, MAX_UNPLANNED_INPUTS } from './inputExceptionPolicy.js';
import { classifyReviewQueueItem, selectReviewQueueReports, REVIEW_QUEUE_PAGE_SIZE } from './reviewQueuePolicy.js';
import { issueReviewCursor, parseReviewCursor, ReviewCursorError,
  REVIEW_QUEUE_WORK_TYPES, REVIEW_QUEUE_STATE_FILTERS, REVIEW_QUEUE_PRIORITIES } from './reviewQueueCursor.js';
import { reviewQueueStateSql, REVIEW_QUEUE_STATE_GROUPS } from './reviewQueueStateSql.js';
import { REVIEW_QUEUE_DUE_WINDOWS, reviewQueueDueWhere } from './reviewQueueDueWindow.js';
import { normalizeReviewTitleQuery, reviewQueueTitleWhere } from './reviewQueueTitleSearch.js';
import { REVIEW_QUEUE_SORT_MODES, reviewQueueSortOrder,
  reviewQueueOlderWhere } from './reviewQueueSorting.js';
import { REVIEW_VIEW_LIMIT, SHARED_REVIEW_VIEW_LIMIT, parseReviewView,
  publicReviewView, isValidSavedReviewView } from './reviewQueueSavedViews.js';
import { parseRevokeSharedView, REVIEW_VIEW_MODERATION_AUDIT_PAGE_SIZE,
  publicModeratedSharedView, publicModerationEvent
} from './reviewQueueViewModeration.js';

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

const reviewChecklistSchema = z.object({
  time_checked: z.literal(true),
  area_checked: z.literal(true),
  result_checked: z.literal(true),
  operation_checked: z.literal(true),
  evidence_basis: z.enum(['reviewed_files', 'no_files'])
}).strict();

const inputDeclarationSchema = z.object({
  client_declaration_id: z.string().uuid(),
  notes: z.string().trim().max(500).default(''),
  items: z.array(z.object({
    work_order_input_id: z.string().uuid(),
    declared_quantity: z.string().min(1).max(20)
  }).strict()).max(MAX_DECLARED_INPUTS)
}).strict();

const executionReviewSchema = z.object({
  decision: z.enum(['verified', 'rejected']),
  reason: z.string().trim().min(10).max(500).optional(),
  checklist: reviewChecklistSchema.optional()
}).strict().superRefine((body, ctx) => {
  if (body.decision === 'rejected' && !body.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'El rechazo requiere una explicación.' });
  }
  if (body.decision === 'verified' && !body.checklist) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checklist'],
      message: 'La aceptación requiere un checklist de revisión explícito.' });
  }
  if (body.decision === 'rejected' && body.checklist) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checklist'],
      message: 'Los partes rechazados no deben registrar controles como aprobados.' });
  }
  if (body.decision === 'verified' && body.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'La revisión positiva no admite un motivo de rechazo.' });
  }
});

const unplannedInputSchema = z.object({
  client_request_id: z.string().uuid(),
  input_id: z.string().uuid(),
  declared_quantity: z.string().min(1).max(20),
  reason: z.string().trim().min(10).max(500)
}).strict();

const unplannedReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(10).max(500).optional()
}).strict().superRefine((body, ctx) => {
  if (body.decision === 'rejected' && !body.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'El rechazo requiere una explicación.' });
  }
  if (body.decision === 'approved' && body.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'No se adjunta explicación de rechazo a una excepción aprobada.' });
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

// Bounded, tenant-isolated advisory queue for coordinators. Do not use this
// snapshot as an approval token: /review remains the transactional authority.
// Persistent named queries contain criteria only, never tenant data or signed
// cursors. Ownership is checked in SQL and tenant FORCE RLS on every request.
function requireReviewViewOwner(req) {
  if (!['tenant_admin', 'agronomic_coordinator'].includes(req.auth.role.code)) {
    throw new HttpError(403, 'Solo coordinación puede administrar vistas guardadas.',
      undefined, 'ORDER_REVIEW_QUEUE_FORBIDDEN');
  }
}
const reviewViewUuid = z.string().uuid();
const reviewViewVisibility = z.object({visibility:z.enum(['private','shared'])}).strict();

workOrdersRouter.get('/review-queue/views', requireCapability('orders.write'),
  asyncHandler(async (req, res) => {
    requireReviewViewOwner(req);
    if (Object.keys(req.query).length) throw new HttpError(422, 'Consulta de vistas inválida.');
    const own = await queryTenantTransaction(`
      SELECT id, user_id, name, filters, visibility, created_at, updated_at
      FROM work_order_review_views
      WHERE tenant_id = :tenant AND user_id = :user
      ORDER BY created_at DESC, id DESC LIMIT 11
    `, {transaction:req.dbTransaction, type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,user:req.auth.user.id}});
    // Share visibility NEVER implies permission to see a private saved view.
    // A demoted/deactivated publisher does not remain a shared authority.
    const shared = await queryTenantTransaction(`
      SELECT v.id, v.user_id, v.name, v.filters, v.visibility, v.created_at, v.updated_at
      FROM work_order_review_views v
      JOIN memberships m ON m.tenant_id = v.tenant_id AND m.user_id = v.user_id
      WHERE v.tenant_id = :tenant AND v.user_id <> :user
        AND v.visibility = 'shared'
        AND m.role_code = 'tenant_admin' AND m.status = 'active'
      ORDER BY v.created_at DESC, v.id DESC LIMIT 21
    `, {transaction:req.dbTransaction, type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,user:req.auth.user.id}});
    if (own.length > REVIEW_VIEW_LIMIT || shared.length > SHARED_REVIEW_VIEW_LIMIT ||
        [...own,...shared].some(view=>!isValidSavedReviewView(view))) {
      throw new HttpError(409, 'Las vistas guardadas requieren revisión.',
        undefined, 'ORDER_REVIEW_VIEW_INVALID');
    }
    res.set('Cache-Control','private, no-store');
    res.json({data:[...own,...shared].map(view=>publicReviewView(view,req.auth.user.id))});
  }));

workOrdersRouter.post('/review-queue/views', requireCapability('orders.write'),
  asyncHandler(async (req, res) => {
    requireReviewViewOwner(req);
    let submitted;
    try { submitted = parseReviewView(req.body); }
    catch { throw new HttpError(422,'Nombre o filtros de vista inválidos.'); }
    // Lock the *member's* row so concurrent requests cannot exceed the
    // maximum (or race duplicate names) across independent API workers.
    const membership = await queryTenantTransaction(`
      SELECT user_id FROM memberships
      WHERE tenant_id = :tenant AND user_id = :user AND status = 'active'
      FOR UPDATE
    `, {transaction:req.dbTransaction, type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,user:req.auth.user.id}});
    if (membership.length !== 1) throw new HttpError(403,'Membresía no disponible.');
    const count = await queryTenantTransaction(`
      SELECT count(*)::int AS count FROM work_order_review_views
      WHERE tenant_id = :tenant AND user_id = :user
    `, {transaction:req.dbTransaction, type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,user:req.auth.user.id}});
    if (count[0].count >= REVIEW_VIEW_LIMIT) {
      throw new HttpError(409,'Alcanzaste el máximo de diez vistas guardadas.',
        undefined,'ORDER_REVIEW_VIEW_LIMIT');
    }
    let rows;
    try {
      rows = await queryTenantTransaction(`
        INSERT INTO work_order_review_views (tenant_id,user_id,name,filters)
        VALUES (:tenant,:user,:name,CAST(:filters AS jsonb))
        RETURNING id,user_id,name,filters,visibility,created_at,updated_at
      `, {transaction:req.dbTransaction, type:QueryTypes.SELECT,
        replacements:{tenant:req.tenantId,user:req.auth.user.id,
          name:submitted.name,filters:JSON.stringify(submitted.filters)}});
    } catch(error) {
      if (error?.parent?.code === '23505' || error?.original?.code === '23505') {
        throw new HttpError(409,'Ya guardaste una vista con ese nombre.',
          undefined,'ORDER_REVIEW_VIEW_DUPLICATE');
      }
      throw error;
    }
    res.set('Cache-Control','private, no-store');
    res.status(201).json({data:publicReviewView(rows[0],req.auth.user.id)});
  }));

// Only a tenant administrator can publish/unpublish their OWN saved
// criteria. The tenant row lock serializes the tenant-wide 20-view cap.
workOrdersRouter.patch('/review-queue/views/:viewId/visibility', requireCapability('orders.write'),
  asyncHandler(async (req,res) => {
    requireReviewViewOwner(req);
    if (req.auth.role.code !== 'tenant_admin') {
      throw new HttpError(403,'Solo administración puede compartir vistas.');
    }
    if (!reviewViewUuid.safeParse(req.params.viewId).success ||
        Object.keys(req.query).length) throw new HttpError(422,'Vista inválida.');
    const parsed=reviewViewVisibility.safeParse(req.body);
    if (!parsed.success) throw new HttpError(422,'Visibilidad inválida.');
    // Serialize all publishers in the same tenant across application workers.
    // Our scoped raw-SQL helper requires an explicit tenant_id marker.
    await queryTenantTransaction(`
      SELECT pg_advisory_xact_lock(hashtext(:tenant)) AS locked,
             :tenant AS tenant_id
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId}});
    const owned=await queryTenantTransaction(`
      SELECT id, user_id, name, filters, visibility, created_at, updated_at
      FROM work_order_review_views
      WHERE tenant_id = :tenant AND user_id = :user AND id = :id
      FOR UPDATE
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,user:req.auth.user.id,id:req.params.viewId}});
    if (owned.length !== 1) throw new HttpError(404,'Vista no encontrada.');
    if (parsed.data.visibility === 'shared' && owned[0].visibility !== 'shared') {
      const [{count}]=await queryTenantTransaction(`
        SELECT count(*)::int AS count FROM work_order_review_views
        WHERE tenant_id = :tenant AND visibility = 'shared'
      `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
        replacements:{tenant:req.tenantId}});
      if (count >= SHARED_REVIEW_VIEW_LIMIT) {
        throw new HttpError(409,'La empresa alcanzó el máximo de veinte vistas compartidas.',
          undefined,'ORDER_REVIEW_SHARED_LIMIT');
      }
    }
    if (parsed.data.visibility === owned[0].visibility) {
      res.set('Cache-Control','private, no-store');
      return res.json({data:publicReviewView(owned[0],req.auth.user.id)});
    }
    let updated;
    try {
      [updated]=await queryTenantTransaction(`
        UPDATE work_order_review_views SET visibility=:visibility, updated_at=now()
        WHERE tenant_id=:tenant AND user_id=:user AND id=:id
        RETURNING id,user_id,name,filters,visibility,created_at,updated_at
      `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
        replacements:{tenant:req.tenantId,user:req.auth.user.id,
          id:req.params.viewId,visibility:parsed.data.visibility}});
    } catch(error) {
      if (error?.parent?.code === '23505' || error?.original?.code === '23505') {
        throw new HttpError(409,'Ya existe una vista compartida con ese nombre.',
          undefined,'ORDER_REVIEW_SHARED_DUPLICATE');
      }
      throw error;
    }
    res.set('Cache-Control','private, no-store');
    res.json({data:publicReviewView(updated,req.auth.user.id)});
  }));

// Administrative inventory deliberately contains only CURRENTLY shared
// criteria names/IDs. Hidden or inactive authors are included so obsolete
// shares can be revoked; their filters and identities are not exposed here.
function requireReviewViewModerator(req) {
  requireReviewViewOwner(req);
  if (req.auth.role.code !== 'tenant_admin') {
    throw new HttpError(403, 'Solo administración puede moderar vistas.');
  }
}
workOrdersRouter.get('/review-queue/views/moderation', requireCapability('orders.write'),
  asyncHandler(async (req,res) => {
    requireReviewViewModerator(req);
    if (Object.keys(req.query).length) throw new HttpError(422,'Consulta inválida.');
    const rows=await queryTenantTransaction(`
      SELECT v.id, v.name, v.created_at,
        (m.status = 'active' AND m.role_code = 'tenant_admin') AS publisher_active
      FROM work_order_review_views v
      LEFT JOIN memberships m
        ON m.tenant_id = v.tenant_id AND m.user_id = v.user_id
      WHERE v.tenant_id=:tenant AND v.visibility='shared' AND v.user_id<>:actor
      ORDER BY v.created_at DESC,v.id DESC LIMIT 21
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,actor:req.auth.user.id}});
    if(rows.length>SHARED_REVIEW_VIEW_LIMIT) {
      throw new HttpError(409,'Inventario de vistas compartidas requiere revisión.');
    }
    res.set('Cache-Control','private, no-store');
    res.json({data:rows.map(publicModeratedSharedView)});
  }));

workOrdersRouter.get('/review-queue/views/moderation/audit', requireCapability('orders.write'),
  asyncHandler(async(req,res) => {
    requireReviewViewModerator(req);
    if(Object.keys(req.query).length) throw new HttpError(422,'Consulta inválida.');
    const rows=await queryTenantTransaction(`
      SELECT id,view_id,view_name,actor_user_id,view_owner_id,reason,
        action,created_at
      FROM work_order_review_view_moderation_audit
      WHERE tenant_id=:tenant
      ORDER BY created_at DESC,id DESC
      LIMIT 50
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId}});
    res.set('Cache-Control','private, no-store');
    res.json({data:rows.map(publicModerationEvent),
      page_size:REVIEW_VIEW_MODERATION_AUDIT_PAGE_SIZE});
  }));

// Exceptional moderation is revoke-only: the author retains the private
// record, all six filters, and deletion authority. Nothing is copied to the
// actor. UPDATE and audit INSERT must commit or roll back together.
workOrdersRouter.post('/review-queue/views/moderation/:viewId/revoke', requireCapability('orders.write'),
  asyncHandler(async(req,res) => {
    requireReviewViewModerator(req);
    if (!reviewViewUuid.safeParse(req.params.viewId).success ||
        Object.keys(req.query).length) throw new HttpError(422,'Vista inválida.');
    let reason;
    try { reason = parseRevokeSharedView(req.body).reason; }
    catch { throw new HttpError(422,'Motivo de revocación inválido.'); }
    // Same tenant advisory lock as owner publish/unpublish to serialize
    // moderation against a concurrent share/rename/capacity change.
    await queryTenantTransaction(`
      SELECT pg_advisory_xact_lock(hashtext(:tenant)) AS locked,
             :tenant AS tenant_id
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId}});
    const ownedByAnother=await queryTenantTransaction(`
      SELECT id,user_id,name FROM work_order_review_views
      WHERE tenant_id=:tenant AND id=:id AND user_id<>:actor
        AND visibility='shared'
      FOR UPDATE
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,id:req.params.viewId,
        actor:req.auth.user.id}});
    if (ownedByAnother.length !== 1) {
      throw new HttpError(404,'Vista compartida no encontrada.');
    }
    const target=ownedByAnother[0];
    const updated=await queryTenantTransaction(`
      UPDATE work_order_review_views
      SET visibility='private',updated_at=now()
      WHERE tenant_id=:tenant AND id=:id AND user_id=:owner
        AND visibility='shared'
      RETURNING id
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,id:target.id,owner:target.user_id}});
    if(updated.length!==1) throw new HttpError(409,'La vista cambió durante la moderación.');
    const [event]=await queryTenantTransaction(`
      INSERT INTO work_order_review_view_moderation_audit
        (tenant_id,view_id,view_owner_id,actor_user_id,view_name,reason)
      VALUES (:tenant,:id,:owner,:actor,:name,:reason)
      RETURNING id,view_id,view_name,actor_user_id,view_owner_id,
        reason,action,created_at
    `, {transaction:req.dbTransaction,type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,id:target.id,owner:target.user_id,
        actor:req.auth.user.id,name:target.name,reason}});
    res.set('Cache-Control','private, no-store');
    res.json({data:publicModerationEvent(event)});
  }));

workOrdersRouter.delete('/review-queue/views/:viewId', requireCapability('orders.write'),
  asyncHandler(async (req, res) => {
    requireReviewViewOwner(req);
    if (!reviewViewUuid.safeParse(req.params.viewId).success ||
        Object.keys(req.query).length) throw new HttpError(422,'Vista inválida.');
    const rows = await queryTenantTransaction(`
      DELETE FROM work_order_review_views
      WHERE tenant_id = :tenant AND user_id = :user AND id = :id
      RETURNING id
    `, {transaction:req.dbTransaction, type:QueryTypes.SELECT,
      replacements:{tenant:req.tenantId,user:req.auth.user.id,id:req.params.viewId}});
    if (!rows.length) throw new HttpError(404,'Vista no encontrada.');
    res.set('Cache-Control','private, no-store');
    res.json({data:{id:rows[0].id}});
  }));

workOrdersRouter.get('/review-queue', requireCapability('orders.write'), asyncHandler(async (req, res) => {
  if (!['tenant_admin', 'agronomic_coordinator'].includes(req.auth.role.code)) {
    throw new HttpError(403, 'Solo coordinación puede consultar pendientes de revisión.',
      undefined, 'ORDER_REVIEW_QUEUE_FORBIDDEN');
  }
  const workType = req.query.type ?? 'all';
  const reviewState = req.query.state ?? 'all';
  const priority = req.query.priority ?? 'all';
  const dueWindow = req.query.due ?? 'all';
  const sortMode = req.query.sort ?? 'newest';
  let titleQuery;
  try {
    titleQuery = normalizeReviewTitleQuery(req.query.q ?? '');
    if (Object.hasOwn(req.query, 'q') && !titleQuery) throw new Error('empty query');
  } catch {
    throw new HttpError(422, 'Texto de búsqueda de título inválido.',
      undefined, 'ORDER_REVIEW_CURSOR_INVALID');
  }
  if (Object.keys(req.query).some(key => key !== 'cursor' && key !== 'type' && key !== 'state' && key !== 'priority' && key !== 'due' && key !== 'q' && key !== 'sort') ||
      (req.query.cursor != null && (typeof req.query.cursor !== 'string' || !req.query.cursor)) ||
      typeof workType !== 'string' || !REVIEW_QUEUE_WORK_TYPES.includes(workType) ||
      typeof reviewState !== 'string' || !REVIEW_QUEUE_STATE_FILTERS.includes(reviewState) ||
      typeof priority !== 'string' || !REVIEW_QUEUE_PRIORITIES.includes(priority) ||
      typeof dueWindow !== 'string' || !REVIEW_QUEUE_DUE_WINDOWS.includes(dueWindow) ||
      typeof sortMode !== 'string' || !REVIEW_QUEUE_SORT_MODES.includes(sortMode)) {
    throw new HttpError(422, 'Filtro o cursor de bandeja inválidos.',
      undefined, 'ORDER_REVIEW_CURSOR_INVALID');
  }
  let cursor;
  try {
    cursor = req.query.cursor
      ? parseReviewCursor(req.query.cursor, { tenantId: req.tenantId,
        userId: req.auth.user.id, workType, reviewState, priority, dueWindow, titleQuery, sortMode })
      : null;
  } catch (error) {
    if (!(error instanceof ReviewCursorError)) throw error;
    throw new HttpError(422, error.message, undefined, error.code);
  }
  const anchor = cursor?.anchor || new Date();
  // Millisecond truncation and all sort expressions live in reviewQueueSorting,
  // keeping ORDER BY and the keyset predicate byte-for-byte equivalent.
  const older = cursor ? reviewQueueOlderWhere(sortMode, cursor) : {};
  const rows = await WorkOrder.findAll({
    where: { tenant_id: req.tenantId, status: 'in_progress',
      ...(workType === 'all' ? {} : { type: workType }),
      ...(priority === 'all' ? {} : { priority }),
      ...reviewQueueDueWhere(dueWindow, anchor),
      ...(reviewState === 'all' && !titleQuery ? {} : {
        [Op.and]: [
          ...(reviewState === 'all' ? [] : [
            where(literal(reviewQueueStateSql(req.auth.user.id)), {
              [Op.in]: REVIEW_QUEUE_STATE_GROUPS[reviewState]
            })
          ]),
          ...(titleQuery ? [reviewQueueTitleWhere(titleQuery)] : [])
        ]
      }),
      created_at: { [Op.lte]: anchor }, ...older },
    attributes: ['id', 'title', 'type', 'priority', 'due_at', 'status', 'created_at'],
    order: reviewQueueSortOrder(sortMode),
    limit: REVIEW_QUEUE_PAGE_SIZE + 1,
    transaction: req.dbTransaction
  });
  const hasMore = rows.length > REVIEW_QUEUE_PAGE_SIZE;
  const orders = rows.slice(0, REVIEW_QUEUE_PAGE_SIZE);
  const nextCursor = hasMore ? issueReviewCursor({
    tenantId: req.tenantId, userId: req.auth.user.id, workType, reviewState, priority, dueWindow, titleQuery, sortMode, anchor,
    last: orders[orders.length - 1]
  }) : null;
  const ids = orders.map(order => order.id);
  if (!ids.length) {
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: [], pagination: { page_size: REVIEW_QUEUE_PAGE_SIZE,
      has_more: false, next_cursor: null } });
    return;
  }
  const reports = await WorkOrderExecution.findAll({
    where: { tenant_id: req.tenantId, work_order_id: { [Op.in]: ids },
      review_status: { [Op.in]: ['submitted', 'verified'] } },
    attributes: ['id', 'work_order_id', 'review_status', 'submitted_by', 'input_declaration'],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: REVIEW_QUEUE_PAGE_SIZE * MAX_EXECUTION_REPORTS + 1,
    transaction: req.dbTransaction
  });
  if (reports.length > REVIEW_QUEUE_PAGE_SIZE * MAX_EXECUTION_REPORTS) {
    throw new HttpError(409, 'El historial excede el límite de partes de la bandeja.',
      undefined, 'ORDER_REVIEW_QUEUE_REPORT_LIMIT');
  }
  const latestReports = selectReviewQueueReports(reports);
  const selectedReportIds = [...latestReports.values()].map(report => report.id);
  const [planned, exceptions, evidence] = await Promise.all([
    WorkOrderInput.findAll({
      where: { tenant_id: req.tenantId, work_order_id: { [Op.in]: ids } },
      attributes: ['id', 'work_order_id'], transaction: req.dbTransaction
    }),
    selectedReportIds.length ? WorkOrderExecutionException.findAll({
      where: { tenant_id: req.tenantId, work_order_execution_id: { [Op.in]: selectedReportIds } },
      attributes: ['id', 'work_order_execution_id', 'review_status'],
      limit: REVIEW_QUEUE_PAGE_SIZE * MAX_UNPLANNED_INPUTS + 1,
      transaction: req.dbTransaction
    }) : [],
    selectedReportIds.length ? EvidenceAsset.findAll({
      where: { tenant_id: req.tenantId, work_order_execution_id: { [Op.in]: selectedReportIds } },
      attributes: ['id', 'work_order_execution_id'],
      limit: REVIEW_QUEUE_PAGE_SIZE * EXECUTION_EVIDENCE_LIMIT + 1,
      transaction: req.dbTransaction
    }) : []
  ]);
  if (exceptions.length > REVIEW_QUEUE_PAGE_SIZE * MAX_UNPLANNED_INPUTS ||
      evidence.length > REVIEW_QUEUE_PAGE_SIZE * EXECUTION_EVIDENCE_LIMIT) {
    throw new HttpError(409, 'La bandeja supera los límites de evidencias del flujo.',
      undefined, 'ORDER_REVIEW_QUEUE_DATA_LIMIT');
  }
  const countBy = (list, key) => list.reduce((map, item) => {
    const value = item[key];
    map.set(value, (map.get(value) || 0) + 1);
    return map;
  }, new Map());
  const planCounts = countBy(planned, 'work_order_id');
  const evidenceCounts = countBy(evidence, 'work_order_execution_id');
  const exceptionsByReport = new Map();
  for (const exception of exceptions) {
    const current = exceptionsByReport.get(exception.work_order_execution_id) || [];
    current.push(exception);
    exceptionsByReport.set(exception.work_order_execution_id, current);
  }
  const data = orders.map(order => {
    const report = latestReports.get(order.id);
    return classifyReviewQueueItem({
      order, report, plannedInputCount: planCounts.get(order.id) || 0,
      exceptions: exceptionsByReport.get(report?.id) || [],
      evidenceCount: evidenceCounts.get(report?.id) || 0,
      reviewerId: req.auth.user.id
    });
  });
  // An unexpected SQL/JS classification drift is never an empty/success page.
  // This also guards additions to the advisory classifier without SQL updates.
  if (reviewState !== 'all' && data.some(item =>
    !REVIEW_QUEUE_STATE_GROUPS[reviewState].includes(item.state))) {
    throw new HttpError(409, 'La clasificación de pendientes cambió; reiniciá la consulta.',
      undefined, 'ORDER_REVIEW_STATE_MISMATCH');
  }
  res.set('Cache-Control', 'private, no-store');
  res.json({ data, pagination: {
    page_size: REVIEW_QUEUE_PAGE_SIZE, has_more: hasMore, next_cursor: nextCursor
  } });
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

// A single authored snapshot, atomically stored on the report. All planned
// materials must be accounted for; "0" means declared zero use, never stock
// deduction. No vendor/physical evidence is inferred from this record.
workOrdersRouter.post('/:id/executions/:executionId/input-declaration', requireCapability('orders.execute'),
  validate(inputDeclarationSchema), asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id, true);
    const report = await WorkOrderExecution.findOne({
      where: { tenant_id: req.tenantId, work_order_id: order.id, id: req.params.executionId },
      transaction: req.dbTransaction
    });
    if (!report) throw new HttpError(404, 'Parte de ejecución no encontrado.',
      undefined, 'EXECUTION_NOT_FOUND');
    if (report.submitted_by !== req.auth.user.id) {
      throw new HttpError(403, 'Solo quien presentó el parte puede declarar insumos utilizados.',
        undefined, 'EXECUTION_INPUT_AUTHOR_REQUIRED');
    }
    if (report.input_declaration) {
      if (!sameInputDeclaration(report.input_declaration, req.body)) {
        throw new HttpError(409, 'Esta declaración ya existe; no puede modificarse después de presentarla.',
          undefined, 'EXECUTION_INPUT_ALREADY_DECLARED');
      }
      res.set('Cache-Control', 'private, no-store');
      res.json({ data: report, replayed: true });
      return;
    }
    if (order.status !== 'in_progress' || report.review_status !== 'submitted') {
      throw new HttpError(409, 'Los insumos deben informarse mientras el parte aguarda revisión.',
        undefined, 'EXECUTION_INPUT_DECLARATION_CLOSED');
    }
    const rows = await WorkOrderInput.findAll({
      where: { tenant_id: req.tenantId, work_order_id: order.id },
      attributes: ['id', 'input_id', 'total_quantity'],
      include: [{ model: AgriculturalInput, attributes: ['id', 'name', 'unit'], required: true }],
      order: [['id', 'ASC']], limit: MAX_DECLARED_INPUTS + 1,
      transaction: req.dbTransaction
    });
    const declaration = buildInputDeclaration({
      rows: rows.map(item => item.toJSON()),
      payload: req.body, userId: req.auth.user.id
    });
    await report.update({ input_declaration: declaration }, { transaction: req.dbTransaction });
    await AuditEvent.create({
      tenant_id: req.tenantId, actor_id: req.auth.user.id,
      action: 'work_order.execution_inputs_declared', entity_type: 'work_order',
      entity_id: order.id, after: {
        execution_id: report.id, input_count: declaration.items.length,
        contains_variance: declaration.items.some(item => item.variance_quantity !== null &&
          item.variance_quantity !== '0')
      },
      request_id: safeAuditRequestId(req.requestId)
    }, { transaction: req.dbTransaction });
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json({ data: report, replayed: false });
  }));

// A contractor can choose a catalog product while assigned to this order,
// without granting broad assets.read permissions for unrelated resources.
workOrdersRouter.get('/:id/unplanned-input-options', requireCapability('orders.execute'),
  asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id);
    const assigned = req.auth.role.code === 'contractor' &&
      await contractorAssignedToOrder(req, order.id);
    if (!canSubmitExecution(req.auth.role.code, assigned)) {
      throw new HttpError(403, 'No podés declarar insumos de esta orden.',
        undefined, 'EXECUTION_EXCEPTION_AUTHOR_REQUIRED');
    }
    const inputs = await AgriculturalInput.findAll({
      attributes: ['id', 'name', 'unit', 'category'],
      order: [['name', 'ASC'], ['id', 'ASC']],
      limit: 100,
      transaction: req.dbTransaction
    });
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: inputs });
  }));

workOrdersRouter.get('/:id/execution-exceptions', requireCapability('orders.read'),
  asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id);
    const items = await WorkOrderExecutionException.findAll({
      where: { tenant_id: req.tenantId, work_order_id: order.id },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
      limit: MAX_EXECUTION_REPORTS * MAX_UNPLANNED_INPUTS,
      transaction: req.dbTransaction
    });
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: items.map(publicException) });
  }));

workOrdersRouter.post('/:id/executions/:executionId/exceptions', requireCapability('orders.execute'),
  validate(unplannedInputSchema), asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id, true);
    const report = await WorkOrderExecution.findOne({
      where: { tenant_id: req.tenantId, work_order_id: order.id, id: req.params.executionId },
      transaction: req.dbTransaction
    });
    if (!report) throw new HttpError(404, 'Parte de ejecución no encontrado.',
      undefined, 'EXECUTION_NOT_FOUND');
    if (report.submitted_by !== req.auth.user.id) {
      throw new HttpError(403, 'Solo el autor del parte puede declarar insumos no previstos.',
        undefined, 'EXECUTION_EXCEPTION_AUTHOR_REQUIRED');
    }
    const existing = await WorkOrderExecutionException.findOne({
      where: { tenant_id: req.tenantId, submitted_by: req.auth.user.id,
        client_request_id: req.body.client_request_id },
      transaction: req.dbTransaction
    });
    const context = { orderId: order.id, executionId: report.id, actorId: req.auth.user.id };
    if (existing) {
      if (!sameUnplannedRequest(existing, req.body, context)) {
        throw new HttpError(409, 'La clave de solicitud corresponde a otra excepción.',
          undefined, 'EXECUTION_EXCEPTION_REPLAY_CONFLICT');
      }
      res.set('Cache-Control', 'private, no-store');
      res.json({ data: publicException(existing), replayed: true });
      return;
    }
    if (order.status !== 'in_progress' || report.review_status !== 'submitted') {
      throw new HttpError(409, 'El parte ya no acepta insumos no previstos.',
        undefined, 'EXECUTION_EXCEPTION_CLOSED');
    }
    const quantity = positiveDeclaredQuantity(req.body.declared_quantity);
    const planned = await WorkOrderInput.findOne({
      where: { tenant_id: req.tenantId, work_order_id: order.id, input_id: req.body.input_id },
      attributes: ['id'], transaction: req.dbTransaction
    });
    if (planned) throw new HttpError(409, 'Este insumo ya está en el plan; usá la declaración ordinaria.',
      undefined, 'EXECUTION_EXCEPTION_ALREADY_PLANNED');
    const catalog = await AgriculturalInput.findOne({
      where: { tenant_id: req.tenantId, id: req.body.input_id },
      attributes: ['id', 'name', 'unit'], transaction: req.dbTransaction
    });
    if (!catalog) throw new HttpError(422, 'El insumo no pertenece al catálogo de esta empresa.',
      undefined, 'EXECUTION_EXCEPTION_INPUT_INVALID');
    const sameCatalogItem = await WorkOrderExecutionException.findOne({
      where: { tenant_id: req.tenantId, work_order_execution_id: report.id, input_id: catalog.id },
      attributes: ['id'], transaction: req.dbTransaction
    });
    if (sameCatalogItem) throw new HttpError(409,
      'El insumo no previsto ya fue informado en este parte.',
      undefined, 'EXECUTION_EXCEPTION_DUPLICATE_INPUT');
    const count = await WorkOrderExecutionException.count({
      where: { tenant_id: req.tenantId, work_order_execution_id: report.id },
      transaction: req.dbTransaction
    });
    if (count >= MAX_UNPLANNED_INPUTS) throw new HttpError(409,
      'El parte admite hasta ocho excepciones de insumos.',
      undefined, 'EXECUTION_EXCEPTION_LIMIT');
    const [exception, created] = await WorkOrderExecutionException.findOrCreate({
      where: { tenant_id: req.tenantId, submitted_by: req.auth.user.id,
        client_request_id: req.body.client_request_id },
      defaults: {
        tenant_id: req.tenantId, work_order_id: order.id,
        work_order_execution_id: report.id, input_id: catalog.id,
        client_request_id: req.body.client_request_id, submitted_by: req.auth.user.id,
        input_name: catalog.name, unit: catalog.unit, quantity, reason: req.body.reason,
        review_status: 'submitted'
      },
      transaction: req.dbTransaction
    });
    if (!created) {
      if (!sameUnplannedRequest(exception, req.body, context)) {
        throw new HttpError(409, 'La clave de solicitud corresponde a otra excepción.',
          undefined, 'EXECUTION_EXCEPTION_REPLAY_CONFLICT');
      }
    } else await AuditEvent.create({
      tenant_id: req.tenantId, actor_id: req.auth.user.id,
      action: 'work_order.unplanned_input_submitted', entity_type: 'work_order',
      entity_id: order.id, after: { execution_id: report.id, exception_id: exception.id },
      request_id: safeAuditRequestId(req.requestId)
    }, { transaction: req.dbTransaction });
    res.set('Cache-Control', 'private, no-store');
    res.status(created ? 201 : 200).json({ data: publicException(exception), replayed: !created });
  }));

workOrdersRouter.post('/:id/executions/:executionId/exceptions/:exceptionId/review', requireCapability('orders.write'),
  validate(unplannedReviewSchema), asyncHandler(async (req, res) => {
    const order = await readableWorkOrder(req, req.params.id, true);
    if (order.status !== 'in_progress') {
      throw new HttpError(409, 'La orden ya no admite revisiones.',
        undefined, 'EXECUTION_EXCEPTION_REVIEW_CLOSED');
    }
    const report = await WorkOrderExecution.findOne({
      where: { tenant_id: req.tenantId, work_order_id: order.id, id: req.params.executionId },
      transaction: req.dbTransaction
    });
    if (!report) throw new HttpError(404, 'Parte de ejecución no encontrado.');
    const exception = await WorkOrderExecutionException.findOne({
      where: { tenant_id: req.tenantId, work_order_id: order.id,
        work_order_execution_id: report.id, id: req.params.exceptionId },
      transaction: req.dbTransaction
    });
    if (!exception) throw new HttpError(404, 'Excepción no encontrada.',
      undefined, 'EXECUTION_EXCEPTION_NOT_FOUND');
    if (!canReviewException(req.auth.role.code, req.auth.user.id, exception.submitted_by)) {
      throw new HttpError(403, 'La revisión requiere un coordinador distinto del autor.',
        undefined, 'EXECUTION_EXCEPTION_SELF_REVIEW_DENIED');
    }
    if (report.review_status !== 'submitted' || exception.review_status !== 'submitted') {
      throw new HttpError(409, 'La excepción ya no está pendiente de revisión.',
        undefined, 'EXECUTION_EXCEPTION_ALREADY_REVIEWED');
    }
    await exception.update({
      review_status: req.body.decision, reviewed_by: req.auth.user.id,
      reviewed_at: new Date(), review_note: req.body.decision === 'rejected' ? req.body.reason : null
    }, { transaction: req.dbTransaction });
    await AuditEvent.create({
      tenant_id: req.tenantId, actor_id: req.auth.user.id,
      action: 'work_order.unplanned_input_reviewed', entity_type: 'work_order',
      entity_id: order.id,
      after: { execution_id: report.id, exception_id: exception.id, decision: exception.review_status },
      request_id: safeAuditRequestId(req.requestId)
    }, { transaction: req.dbTransaction });
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: publicException(exception) });
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
  // The order row is already locked, including against evidence uploads.
  // A reviewer must distinguish files actually reviewed from acknowledged
  // absence, and attached bytes must pass the same bounded hash verification
  // as the private download endpoint (not simply metadata "present").
  let attachmentCount = 0;
  if (req.body.decision === 'verified') {
    // Planning lines are frozen after approval, so an independent reviewer
    // cannot approve a report that omitted its planned input declarations.
    const plannedCount = await WorkOrderInput.count({
      where: { tenant_id: req.tenantId, work_order_id: order.id },
      transaction: req.dbTransaction
    });
    if (!hasRequiredInputDeclaration(plannedCount, report)) {
      throw new HttpError(409, 'Antes de aceptar, el responsable debe informar los insumos planificados utilizados.',
        undefined, 'EXECUTION_INPUT_DECLARATION_REQUIRED');
    }
    const exceptions = await WorkOrderExecutionException.findAll({
      where: { tenant_id: req.tenantId, work_order_id: order.id, work_order_execution_id: report.id },
      attributes: ['id', 'review_status'], limit: MAX_UNPLANNED_INPUTS + 1,
      transaction: req.dbTransaction
    });
    if (!canApproveWithExceptions(exceptions)) {
      throw new HttpError(409, 'Hay insumos no previstos pendientes o rechazados. Corregí el parte antes de aprobar.',
        undefined, 'EXECUTION_UNPLANNED_INPUT_REVIEW_REQUIRED');
    }
    const attachments = await EvidenceAsset.findAll({
      where: { tenant_id: req.tenantId, work_order_id: order.id,
        work_order_execution_id: report.id },
      attributes: ['id', 'content_sha256', 'size_bytes'],
      limit: EXECUTION_EVIDENCE_LIMIT + 1,
      transaction: req.dbTransaction
    });
    attachmentCount = attachments.length;
    if (!canAcceptReviewChecklist(order.type, req.body.checklist, attachmentCount)) {
      throw new HttpError(409,
        'Completá la revisión y especificá correctamente los archivos; aplicación y fertilización exigen respaldo privado.',
        undefined, 'EXECUTION_REVIEW_CHECKLIST_REQUIRED');
    }
    for (const asset of attachments) {
      const blobLength = await getPrivateEvidenceByteLength({
        tenantId: req.tenantId, evidenceId: asset.id, transaction: req.dbTransaction
      });
      const bytes = shouldReadEvidenceBytes(asset.content_sha256, asset.size_bytes, blobLength)
        ? await getBoundedPrivateEvidence({
          tenantId: req.tenantId, evidenceId: asset.id, transaction: req.dbTransaction
        }) : undefined;
      const status = classifyEvidenceIntegrity({
        expectedHash: asset.content_sha256, declaredSize: asset.size_bytes,
        blobLength, bytes
      });
      if (status !== 'verified') {
        throw new HttpError(409, 'Un archivo adjunto está ausente o no supera el control de integridad.',
          undefined, 'EXECUTION_REVIEW_EVIDENCE_INTEGRITY_FAILED');
      }
    }
  }
  await report.update({
    review_status: req.body.decision,
    reviewed_by: req.auth.user.id,
    reviewed_at: new Date(),
    review_note: req.body.decision === 'rejected' ? req.body.reason : null,
    review_checklist: req.body.decision === 'verified' ? req.body.checklist : null
  }, { transaction: req.dbTransaction });
  await AuditEvent.create({
    tenant_id: req.tenantId, actor_id: req.auth.user.id,
    action: 'work_order.execution_reviewed', entity_type: 'work_order',
    entity_id: order.id, before: { execution_id: report.id, review_status: 'submitted' },
    after: { execution_id: report.id, review_status: report.review_status,
      ...(req.body.decision === 'verified' ? { checklist_recorded: true,
        evidence_basis: req.body.checklist.evidence_basis, attachment_count: attachmentCount } : {}) },
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
  // An approved plan is a baseline against which authored declarations are
  // compared. Serialize planning with every status transition and submission.
  const order = await readableWorkOrder(req, req.params.id, true);
  if (!['draft', 'pending_approval'].includes(order.status)) {
    throw new HttpError(409, 'Los insumos planificados se congelan al aprobar la orden.',
      undefined, 'WORK_ORDER_INPUT_PLAN_FROZEN');
  }
  const catalog = await AgriculturalInput.findOne({
    where: { tenant_id: req.tenantId, id: req.body.input_id },
    attributes: ['id'], transaction: req.dbTransaction
  });
  if (!catalog) throw new HttpError(422, 'El insumo no pertenece al catálogo de la empresa.',
    undefined, 'WORK_ORDER_INPUT_INVALID');
  const where = { tenant_id: req.tenantId, work_order_id: order.id, input_id: catalog.id };
  const [input, created] = await WorkOrderInput.findOrCreate({
    where, defaults: req.body, transaction: req.dbTransaction
  });
  if (!created) {
    const same = String(input.dose ?? '') === String(req.body.dose ?? '') &&
      String(input.total_quantity ?? '') === String(req.body.total_quantity ?? '') &&
      (input.dose_unit ?? '') === (req.body.dose_unit ?? '') &&
      (input.notes ?? '') === (req.body.notes ?? '');
    if (!same) throw new HttpError(409, 'El insumo ya fue planificado con otras cantidades.',
      undefined, 'WORK_ORDER_INPUT_PLAN_CONFLICT');
  }
  if (created) await AuditEvent.create({
    tenant_id: req.tenantId, actor_id: req.auth.user.id,
    action: 'work_order.input_planned', entity_type: 'work_order',
    entity_id: order.id, after: { planned_input_id: input.id, input_id: input.input_id },
    request_id: safeAuditRequestId(req.requestId)
  }, { transaction: req.dbTransaction });
  res.status(created ? 201 : 200).json({ data: input, replayed: !created });
}));

workOrdersRouter.post('/:id/machinery', requireCapability('orders.write'), validate(machinerySchema), asyncHandler(async (req, res) => {
  const machine = await WorkOrderMachinery.create({
    ...req.body,
    work_order_id: req.params.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: machine });
}));
