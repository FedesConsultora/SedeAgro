import { Router } from 'express';
import { z } from 'zod';
import { Field, SatelliteLayer } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';

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

imageryRouter.get('/layers', requireCapability('imagery.read'), asyncHandler(async (req, res) => {
  const layers = await SatelliteLayer.findAll({
    include: [{ model: Field, attributes: ['id', 'name', 'area_hectares'] }],
    order: [['captured_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: layers });
}));

imageryRouter.post('/layers', requireCapability('imagery.write'), validate(layerSchema), asyncHandler(async (req, res) => {
  // The tenant composite FK is the final boundary, but an absent or foreign
  // field should get a predictable 404 instead of a database constraint error.
  const field = await Field.findOne({
    where: { id: req.body.field_id, tenant_id: req.tenantId },
    attributes: ['id'],
    transaction: req.dbTransaction
  });
  if (!field) {
    throw new HttpError(404, 'Lote no encontrado en esta empresa.',
      undefined, 'IMAGERY_FIELD_NOT_FOUND');
  }
  const layer = await SatelliteLayer.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: layer });
}));
