import { Router } from 'express';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
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
  // The natural key is UNIQUE(tenant_id,field_id,layer_type,captured_at).
  // Repeated identical uploads refer to the same stored layer; any changed
  // provider, object key or metadata is a provenance conflict, never an update.
  const [layer, created] = await SatelliteLayer.findOrCreate({
    where: {
      tenant_id: req.tenantId,
      field_id: field.id,
      layer_type: req.body.layer_type,
      captured_at: req.body.captured_at
    },
    defaults: {
      provider: req.body.provider,
      storage_key: req.body.storage_key,
      metadata: req.body.metadata
    },
    transaction: req.dbTransaction
  });
  if (!created && (
    layer.provider !== req.body.provider ||
    layer.storage_key !== req.body.storage_key ||
    !isDeepStrictEqual(layer.metadata, req.body.metadata)
  )) {
    throw new HttpError(409, 'La capa ya existe con otro origen o contenido.',
      undefined, 'IMAGERY_LAYER_CONFLICT');
  }
  res.status(created ? 201 : 200).json({ data: layer, replayed: !created });
}));
