import { Router } from 'express';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { AgriculturalInput, Machinery } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';

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

assetsRouter.get('/machinery', requireCapability('assets.read'), asyncHandler(async (req, res) => {
  const machinery = await Machinery.findAll({
    order: [['kind', 'ASC'], ['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: machinery });
}));

assetsRouter.post('/machinery', requireCapability('assets.write'), validate(machinerySchema), asyncHandler(async (req, res) => {
  // A serial number identifies one physical machine within a tenant. Reuse it
  // for identical HTTP retries, but never rewrite a machine already referenced
  // by operational work orders. Unnumbered machines have no safe natural key:
  // two tractors with the same name may still be distinct equipment.
  if (!req.body.serial_number) {
    const machine = await Machinery.create(req.body, { transaction: req.dbTransaction });
    return res.status(201).json({ data: machine });
  }
  const [machine, created] = await Machinery.findOrCreate({
    where: { tenant_id: req.tenantId, serial_number: req.body.serial_number },
    defaults: req.body,
    transaction: req.dbTransaction
  });
  if (!created && (
    machine.name !== req.body.name ||
    machine.kind !== req.body.kind ||
    (machine.brand ?? null) !== (req.body.brand ?? null) ||
    (machine.model ?? null) !== (req.body.model ?? null) ||
    machine.status !== req.body.status ||
    !isDeepStrictEqual(machine.metadata, req.body.metadata)
  )) {
    throw new HttpError(409, 'Ya existe maquinaria con ese número de serie y otra configuración.',
      undefined, 'ASSET_MACHINERY_CONFLICT');
  }
  res.status(created ? 201 : 200).json({ data: machine, replayed: !created });
}));

assetsRouter.get('/inputs', requireCapability('assets.read'), asyncHandler(async (req, res) => {
  const inputs = await AgriculturalInput.findAll({
    order: [['category', 'ASC'], ['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: inputs });
}));

assetsRouter.post('/inputs', requireCapability('assets.write'), validate(inputSchema), asyncHandler(async (req, res) => {
  const input = await AgriculturalInput.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: input });
}));
