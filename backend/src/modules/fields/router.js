import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Field, Farm, RainfallEvent, IrrigationEvent } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate, HttpError } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { grantedProducerIds } from '../farms/producerAccess.js';
import { assignedFieldIds } from '../scouting/scoutFieldScope.js';

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
}).refine(
  event => !event.ended_at || event.ended_at.getTime() >= event.started_at.getTime(),
  { path: ['ended_at'], message: 'La fecha de finalización no puede ser anterior al inicio.' }
);

fieldsRouter.get('/', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const grants = await grantedProducerIds(req);
  const scoutFields = await assignedFieldIds(req);
  const fields = await Field.findAll({
    ...(scoutFields === null ? {} : { where: { id: { [Op.in]: scoutFields } } }),
    include: [{
      model: Farm,
      attributes: ['id', 'name', 'province', 'locality'],
      ...(grants === null ? {} : {
        required: true,
        where: { producer_id: { [Op.in]: grants } }
      })
    }],
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: fields });
}));

fieldsRouter.post('/', requireCapability('gis.write'), validate(fieldSchema), asyncHandler(async (req, res) => {
  // Composite foreign keys enforce tenant isolation, but a missing or foreign
  // farm must be a scoped 404, not a raw database constraint failure.
  const farm = await Farm.findOne({
    where: { id: req.body.farm_id, tenant_id: req.tenantId },
    attributes: ['id'],
    transaction: req.dbTransaction
  });
  if (!farm) {
    throw new HttpError(404, 'Establecimiento no encontrado en esta empresa.',
      undefined, 'FIELD_FARM_NOT_FOUND');
  }
  const field = await Field.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: field });
}));

fieldsRouter.get('/:id', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const grants = await grantedProducerIds(req);
  const scoutFields = await assignedFieldIds(req);
  if (scoutFields !== null && !scoutFields.includes(req.params.id)) {
    return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  }
  const field = await Field.findOne({
    where: { id: req.params.id },
    include: [
      {
        model: Farm,
        attributes: ['id', 'name'],
        ...(grants === null ? {} : {
          required: true,
          where: { producer_id: { [Op.in]: grants } }
        })
      },
      { model: RainfallEvent, limit: 20, order: [['measured_at', 'DESC']] },
      { model: IrrigationEvent, limit: 20, order: [['started_at', 'DESC']] }
    ],
    transaction: req.dbTransaction
  });
  if (!field) return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  res.json({ data: field });
}));

fieldsRouter.post('/:id/rainfall', requireCapability('water.write'), validate(rainfallSchema), asyncHandler(async (req, res) => {
  const assigned = await assignedFieldIds(req);
  if (assigned !== null && !assigned.includes(req.params.id)) {
    return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  }
  const field = await Field.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!field) return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  const event = await RainfallEvent.create({
    ...req.body,
    field_id: req.params.id,
    recorded_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: event });
}));

fieldsRouter.post('/:id/irrigation', requireCapability('water.write'), validate(irrigationSchema), asyncHandler(async (req, res) => {
  const assigned = await assignedFieldIds(req);
  if (assigned !== null && !assigned.includes(req.params.id)) {
    return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  }
  const field = await Field.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!field) return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  const event = await IrrigationEvent.create({
    ...req.body,
    field_id: req.params.id,
    recorded_by: req.auth.user.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: event });
}));

fieldsRouter.patch('/:id', requireCapability('gis.write'), validate(fieldSchema.partial()), asyncHandler(async (req, res) => {
  const field = await Field.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!field) return res.status(404).json({ error: { message: 'Lote no encontrado.' } });
  // The parent farm determines producer_viewer visibility via producer grants.
  // Changing it silently exposes existing scouting and order history to another
  // producer without a new grant. Keep the historical parent stable.
  if (Object.hasOwn(req.body, 'farm_id') && req.body.farm_id !== field.farm_id) {
    throw new HttpError(409, 'No se puede cambiar el establecimiento de un lote existente.',
      undefined, 'FIELD_FARM_IDENTITY_IMMUTABLE');
  }
  await field.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: field });
}));
