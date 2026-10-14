import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Farm, Field, Membership, Producer, ProducerAccessGrant } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate, HttpError } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { grantedProducerIds, isProducerViewer } from './producerAccess.js';

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
  centroid: z.any().optional(),
  notes: z.string().optional()
});

farmsRouter.get('/producers', requireCapability('gis.read'), asyncHandler(async (req, res) => {
  const grants = await grantedProducerIds(req);
  const producers = await Producer.findAll({
    ...(grants === null ? {} : {
      where: { id: { [Op.in]: grants } },
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
  const farms = await Farm.findAll({
    ...(grants === null ? {} : { where: { producer_id: { [Op.in]: grants } } }),
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
  const grants = await grantedProducerIds(req);
  const farm = await Farm.findOne({
    where: {
      id: req.params.id,
      ...(grants === null ? {} : { producer_id: { [Op.in]: grants } })
    },
    include: [
      { model: Producer, attributes: isProducerViewer(req) ? ['id', 'name'] : ['id', 'name', 'contact_email'] },
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
