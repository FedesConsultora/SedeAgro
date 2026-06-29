import { Router } from 'express';
import { z } from 'zod';
import {
  AgriculturalInput,
  CampaignField,
  Field,
  Machinery,
  WorkOrder,
  WorkOrderAssignee,
  WorkOrderInput,
  WorkOrderMachinery
} from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

export const workOrdersRouter = Router();

workOrdersRouter.use(requireEntitlement('work_orders'));

const workOrderSchema = z.object({
  campaign_field_id: z.string().uuid().optional().nullable(),
  field_id: z.string().uuid(),
  type: z.enum(['application', 'sowing', 'fertilization', 'harvest', 'irrigation', 'inspection', 'other']),
  status: z.enum(['draft', 'pending_approval', 'approved', 'assigned', 'in_progress', 'completed', 'cancelled']).default('draft'),
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

workOrdersRouter.get('/', asyncHandler(async (req, res) => {
  const orders = await WorkOrder.findAll({
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

workOrdersRouter.post('/', validate(workOrderSchema), asyncHandler(async (req, res) => {
  const order = await WorkOrder.create({
    ...req.body,
    requested_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: order });
}));

workOrdersRouter.get('/:id', asyncHandler(async (req, res) => {
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

workOrdersRouter.patch('/:id/status', validate(statusSchema), asyncHandler(async (req, res) => {
  const order = await WorkOrder.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!order) return res.status(404).json({ error: { message: 'Orden de trabajo no encontrada.' } });

  const nextStatus = req.body.status;
  await order.update({
    status: nextStatus,
    approved_at: nextStatus === 'approved' ? new Date() : order.approved_at,
    completed_at: nextStatus === 'completed' ? new Date() : order.completed_at
  }, { transaction: req.dbTransaction });

  res.json({ data: order });
}));

workOrdersRouter.post('/:id/assignees', validate(assigneeSchema), asyncHandler(async (req, res) => {
  const assignee = await WorkOrderAssignee.create({
    ...req.body,
    work_order_id: req.params.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: assignee });
}));

workOrdersRouter.post('/:id/inputs', validate(inputSchema), asyncHandler(async (req, res) => {
  const input = await WorkOrderInput.create({
    ...req.body,
    work_order_id: req.params.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: input });
}));

workOrdersRouter.post('/:id/machinery', validate(machinerySchema), asyncHandler(async (req, res) => {
  const machine = await WorkOrderMachinery.create({
    ...req.body,
    work_order_id: req.params.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: machine });
}));
