import { Router } from 'express';
import { z } from 'zod';
import { Field, Farm, RainfallEvent, IrrigationEvent } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

export const fieldsRouter = Router();

fieldsRouter.use(requireEntitlement('gis'));

const fieldSchema = z.object({
  farm_id: z.string().uuid(),
  name: z.string().min(1).max(180),
  area_hectares: z.coerce.number().nonnegative().default(0),
  boundary: z.any().optional(),
  status: z.enum(['active', 'inactive', 'archived']).default('active'),
  notes: z.string().optional()
});

const rainfallSchema = z.object({
  amount_mm: z.coerce.number().nonnegative(),
  measured_at: z.coerce.date(),
  source: z.enum(['manual', 'sensor', 'import']).default('manual'),
  notes: z.string().optional()
});

const irrigationSchema = z.object({
  amount_mm: z.coerce.number().nonnegative().optional(),
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().optional(),
  source: z.enum(['manual', 'sensor', 'import']).default('manual'),
  notes: z.string().optional()
});

fieldsRouter.get('/', asyncHandler(async (req, res) => {
  const fields = await Field.findAll({
    include: [{ model: Farm, attributes: ['id', 'name', 'province', 'locality'] }],
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: fields });
}));

fieldsRouter.post('/', validate(fieldSchema), asyncHandler(async (req, res) => {
  const field = await Field.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: field });
}));

fieldsRouter.get('/:id', asyncHandler(async (req, res) => {
  const field = await Field.findByPk(req.params.id, {
    include: [
      { model: Farm, attributes: ['id', 'name'] },
      { model: RainfallEvent, limit: 20, order: [['measured_at', 'DESC']] },
      { model: IrrigationEvent, limit: 20, order: [['started_at', 'DESC']] }
    ],
    transaction: req.dbTransaction
  });
  if (!field) return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  res.json({ data: field });
}));

fieldsRouter.post('/:id/rainfall', validate(rainfallSchema), asyncHandler(async (req, res) => {
  const event = await RainfallEvent.create({
    ...req.body,
    field_id: req.params.id,
    recorded_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: event });
}));

fieldsRouter.post('/:id/irrigation', validate(irrigationSchema), asyncHandler(async (req, res) => {
  const event = await IrrigationEvent.create({
    ...req.body,
    field_id: req.params.id,
    recorded_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: event });
}));

fieldsRouter.patch('/:id', validate(fieldSchema.partial()), asyncHandler(async (req, res) => {
  const field = await Field.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!field) return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  await field.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: field });
}));
