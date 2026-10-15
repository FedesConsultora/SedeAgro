import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import {
  AgriculturalInput,
  AuditEvent,
  CampaignField,
  Field,
  Machinery,
  Membership,
  User,
  WorkOrder,
  WorkOrderAssignee,
  WorkOrderInput,
  WorkOrderMachinery
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate, HttpError } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { canTransitionWorkOrder } from './workOrderPolicy.js';
import { canAddWorkOrderAssignee, hasActiveWorkOrderExecutor, safeAuditRequestId } from './assignmentPolicy.js';
import { createAssignmentNotification } from '../notifications/assignmentNotifications.js';
import { ORDER_RECIPIENT_ROLES } from '../notifications/assignmentNotificationPolicy.js';

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
  res.json({ data: order });
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
