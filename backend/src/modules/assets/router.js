import { Router } from 'express';
import { z } from 'zod';
import { AgriculturalInput, Machinery } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

export const assetsRouter = Router();

assetsRouter.use(requireEntitlement('work_orders'));

const machinerySchema = z.object({
  name: z.string().min(2).max(180),
  kind: z.enum(['tractor', 'sprayer', 'seeder', 'harvester', 'drone', 'irrigation', 'sensor', 'vehicle', 'other']),
  brand: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  serial_number: z.string().max(120).optional(),
  status: z.enum(['active', 'maintenance', 'inactive', 'archived']).default('active'),
  metadata: z.record(z.any()).default({})
});

const inputSchema = z.object({
  name: z.string().min(2).max(180),
  category: z.enum(['seed', 'herbicide', 'insecticide', 'fungicide', 'fertilizer', 'adjuvant', 'biological', 'other']),
  unit: z.string().min(1).max(40),
  active_ingredient: z.string().max(180).optional(),
  registration_number: z.string().max(120).optional(),
  metadata: z.record(z.any()).default({})
});

assetsRouter.get('/machinery', asyncHandler(async (req, res) => {
  const machinery = await Machinery.findAll({
    order: [['kind', 'ASC'], ['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: machinery });
}));

assetsRouter.post('/machinery', validate(machinerySchema), asyncHandler(async (req, res) => {
  const machine = await Machinery.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: machine });
}));

assetsRouter.get('/inputs', asyncHandler(async (req, res) => {
  const inputs = await AgriculturalInput.findAll({
    order: [['category', 'ASC'], ['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: inputs });
}));

assetsRouter.post('/inputs', validate(inputSchema), asyncHandler(async (req, res) => {
  const input = await AgriculturalInput.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: input });
}));
