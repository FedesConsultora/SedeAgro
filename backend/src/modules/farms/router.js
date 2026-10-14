import { Router } from 'express';
import { z } from 'zod';
import { Farm, Field, Producer } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';

export const farmsRouter = Router();

farmsRouter.use(requireEntitlement('gis'));

const producerSchema = z.object({
  name: z.string().min(2).max(180),
  tax_id: z.string().max(64).optional(),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().max(80).optional(),
  notes: z.string().optional()
});

const farmSchema = z.object({
  producer_id: z.string().uuid().optional().nullable(),
  name: z.string().min(2).max(180),
  locality: z.string().max(140).optional(),
  province: z.string().max(140).optional(),
  country: z.string().max(80).default('Argentina'),
  centroid: z.any().optional(),
  notes: z.string().optional()
});

farmsRouter.get('/producers', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const producers = await Producer.findAll({
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: producers });
}));

farmsRouter.post('/producers', requireCapability('gis.write'), validate(producerSchema), asyncHandler(async (req, res) => {
  const producer = await Producer.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: producer });
}));

farmsRouter.get('/', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const farms = await Farm.findAll({
    include: [
      { model: Producer, attributes: ['id', 'name'] },
      { model: Field, attributes: ['id', 'name', 'area_hectares', 'status'] }
    ],
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: farms });
}));

farmsRouter.post('/', requireCapability('gis.write'), validate(farmSchema), asyncHandler(async (req, res) => {
  const farm = await Farm.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: farm });
}));

farmsRouter.get('/:id', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const farm = await Farm.findByPk(req.params.id, {
    include: [
      { model: Producer, attributes: ['id', 'name', 'contact_email'] },
      { model: Field, order: [['name', 'ASC']] }
    ],
    transaction: req.dbTransaction
  });
  if (!farm) return res.status(404).json({ error: { message: 'Establecimiento no encontrado.' } });
  res.json({ data: farm });
}));

farmsRouter.patch('/:id', requireCapability('gis.write'), validate(farmSchema.partial()), asyncHandler(async (req, res) => {
  const farm = await Farm.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!farm) return res.status(404).json({ error: { message: 'Establecimiento no encontrado.' } });
  await farm.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: farm });
}));

