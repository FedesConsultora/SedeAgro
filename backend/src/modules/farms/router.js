import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Farm, Field, Membership, Producer, ProducerAccessGrant } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate, HttpError } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { grantedProducerIds, isProducerViewer } from './producerAccess.js';
import { assignedFarmIds, assignedFieldIds, isScout } from '../scouting/scoutFieldScope.js';
import { farmCentroidSchema } from './farmCentroidPolicy.js';

export const farmsRouter = Router();

farmsRouter.use(requireEntitlement('gis'));

const producerAccessSchema = z.object({ user_id: z.string().uuid() });
const producerAccessParams = z.object({ producerId: z.string().uuid() });
const producerRevokeParams = producerAccessParams.extend({ userId: z.string().uuid() });

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
  centroid: farmCentroidSchema.nullable().optional(),
  notes: z.string().optional()
});

farmsRouter.get('/producers', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const grants = await grantedProducerIds(req);
  const scoutFarms = await assignedFarmIds(req);
  const scopedFarms = scoutFarms === null ? null : await Farm.findAll({
    where: { id: { [Op.in]: scoutFarms } },
    attributes: ['producer_id'],
    transaction: req.dbTransaction
  });
  const scopedProducerIds = scopedFarms === null ? null :
    [...new Set(scopedFarms.map((farm) => farm.producer_id).filter(Boolean))];
  const producerIds = grants === null ? scopedProducerIds : grants;
  const producers = await Producer.findAll({
    ...(producerIds === null ? {} : {
      where: { id: { [Op.in]: producerIds } },
      attributes: ['id', 'name']
    }),
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
  const grants = await grantedProducerIds(req);
  const scoutFarms = await assignedFarmIds(req);
  const scoutFields = await assignedFieldIds(req);
  const farms = await Farm.findAll({
    where: {
      ...(grants === null ? {} : { producer_id: { [Op.in]: grants } }),
      ...(scoutFarms === null ? {} : { id: { [Op.in]: scoutFarms } })
    },
    include: [
      { model: Producer, attributes: ['id', 'name'] },
      {
        model: Field, attributes: ['id', 'name', 'area_hectares', 'status'],
        ...(scoutFields === null ? {} : { where: { id: { [Op.in]: scoutFields } }, required: false })
      }
    ],
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: farms });
}));

farmsRouter.post('/', requireCapability('gis.write'), validate(farmSchema), asyncHandler(async (req, res) => {
  // The composite FK is the final tenant boundary; reject unknown and foreign
  // producer IDs before INSERT with the same scoped 404 used by the PATCH path.
  if (req.body.producer_id) {
    const producer = await Producer.findOne({
      where: { id: req.body.producer_id, tenant_id: req.tenantId },
      attributes: ['id'],
      transaction: req.dbTransaction
    });
    if (!producer) throw new HttpError(404, 'Productor no encontrado en esta organización.',
      undefined, 'FARM_PRODUCER_NOT_FOUND');
  }
  const farm = await Farm.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: farm });
}));

farmsRouter.get('/:id', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const grants = await grantedProducerIds(req);
  const scoutFarms = await assignedFarmIds(req);
  if (scoutFarms !== null && !scoutFarms.includes(req.params.id)) {
    return res.status(404).json({ error: { message: 'Establecimiento no encontrado.' } });
  }
  const scoutFields = await assignedFieldIds(req);
  const farm = await Farm.findOne({
    where: {
      id: req.params.id,
      ...(grants === null ? {} : { producer_id: { [Op.in]: grants } })
    },
    include: [
      { model: Producer, attributes: isProducerViewer(req) || isScout(req) ? ['id', 'name'] : ['id', 'name', 'contact_email'] },
      {
        model: Field, order: [['name', 'ASC']],
        ...(scoutFields === null ? {} : { where: { id: { [Op.in]: scoutFields } }, required: false })
      }
    ],
    transaction: req.dbTransaction
  });
  if (!farm) return res.status(404).json({ error: { message: 'Establecimiento no encontrado.' } });
  res.json({ data: farm });
}));

farmsRouter.patch('/:id', requireCapability('gis.write'), validate(farmSchema.partial()), asyncHandler(async (req, res) => {
  // Lock the farm row while checking whether the initial producer assignment
  // is safe. Inserts of fields referencing the farm acquire a FK KEY SHARE lock,
  // so this UPDATE lock prevents a concurrent child from bypassing the count.
  const farm = await Farm.findByPk(req.params.id, {
    transaction: req.dbTransaction,
    lock: req.dbTransaction.LOCK.UPDATE
  });
  if (!farm) return res.status(404).json({ error: { message: 'Establecimiento no encontrado.' } });
  if (Object.hasOwn(req.body, 'producer_id') && req.body.producer_id !== farm.producer_id) {
    // Producer grants authorize whole farms and their historical fields.
    // Reparenting a farm with fields, or changing an already assigned producer,
    // would expose prior work to a new producer without an access grant.
    // The one safe onboarding exception is first assigning an empty farm.
    const canAssignEmptyFarm = farm.producer_id === null && req.body.producer_id !== null &&
      await Field.count({
        where: { farm_id: farm.id, tenant_id: req.tenantId },
        transaction: req.dbTransaction
      }) === 0;
    if (!canAssignEmptyFarm) {
      throw new HttpError(409, 'No se puede cambiar el productor de un establecimiento con historial.',
        undefined, 'FARM_PRODUCER_IDENTITY_IMMUTABLE');
    }
    const producer = await Producer.findOne({
      where: { id: req.body.producer_id, tenant_id: req.tenantId },
      attributes: ['id'],
      transaction: req.dbTransaction
    });
    if (!producer) throw new HttpError(404, 'Productor no encontrado en esta organización.',
      undefined, 'FARM_PRODUCER_NOT_FOUND');
  }
  await farm.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: farm });
}));


function notFoundProducer() {
  return new HttpError(404, 'Productor no encontrado en esta organización.');
}

farmsRouter.get('/producers/:producerId/access', requireCapability('producer_access.manage'),
  validate(producerAccessParams, 'params'), asyncHandler(async (req, res) => {
    const producer = await Producer.findByPk(req.params.producerId, { transaction: req.dbTransaction });
    if (!producer) throw notFoundProducer();
    const grants = await ProducerAccessGrant.findAll({
      where: { producer_id: producer.id, tenant_id: req.tenantId },
      attributes: ['id', 'user_id', 'granted_by', 'created_at'],
      order: [['created_at', 'DESC']],
      transaction: req.dbTransaction
    });
    res.json({ data: grants });
  }));

farmsRouter.post('/producers/:producerId/access', requireCapability('producer_access.manage'),
  validate(producerAccessParams, 'params'), validate(producerAccessSchema), asyncHandler(async (req, res) => {
    const producer = await Producer.findByPk(req.params.producerId, { transaction: req.dbTransaction });
    if (!producer) throw notFoundProducer();
    const membership = await Membership.findOne({
      where: {
        tenant_id: req.tenantId,
        user_id: req.body.user_id,
        role_code: 'producer_viewer',
        status: 'active'
      },
      transaction: req.dbTransaction
    });
    if (!membership) {
      throw new HttpError(422, 'Solo se puede autorizar a productores con membresía activa.');
    }
    const [grant, created] = await ProducerAccessGrant.findOrCreate({
      where: {
        tenant_id: req.tenantId,
        user_id: membership.user_id,
        producer_id: producer.id
      },
      defaults: { granted_by: req.auth.user.id },
      transaction: req.dbTransaction
    });
    res.status(created ? 201 : 200).json({
      data: { id: grant.id, user_id: grant.user_id, producer_id: grant.producer_id }
    });
  }));

farmsRouter.delete('/producers/:producerId/access/:userId', requireCapability('producer_access.manage'),
  validate(producerRevokeParams, 'params'), asyncHandler(async (req, res) => {
    const count = await ProducerAccessGrant.destroy({
      where: {
        tenant_id: req.tenantId,
        producer_id: req.params.producerId,
        user_id: req.params.userId
      },
      transaction: req.dbTransaction
    });
    if (!count) throw new HttpError(404, 'Autorización no encontrada.');
    res.status(204).end();
  }));
