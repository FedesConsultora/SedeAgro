import { Router } from 'express';
import { z } from 'zod';
import { Field, SatelliteLayer } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

export const imageryRouter = Router();

imageryRouter.use(requireEntitlement('imagery'));

const layerSchema = z.object({
  field_id: z.string().uuid(),
  provider: z.string().min(2).max(80),
  layer_type: z.enum(['ndvi', 'gndvi', 'rgb', 'evi', 'moisture', 'other']),
  captured_at: z.coerce.date(),
  storage_key: z.string().min(3),
  metadata: z.record(z.any()).default({})
});

imageryRouter.get('/layers', asyncHandler(async (req, res) => {
  const layers = await SatelliteLayer.findAll({
    include: [{ model: Field, attributes: ['id', 'name', 'area_hectares'] }],
    order: [['captured_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: layers });
}));

imageryRouter.post('/layers', validate(layerSchema), asyncHandler(async (req, res) => {
  const layer = await SatelliteLayer.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: layer });
}));
