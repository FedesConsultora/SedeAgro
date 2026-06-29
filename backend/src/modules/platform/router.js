import { Router } from 'express';
import { z } from 'zod';
import { Tenant, User, Plan, TenantModule, Module, Membership } from '../../models/index.js';
import { asyncHandler, HttpError } from '../../utils/http.js';

export const platformRouter = Router();

// Middleware to block non-platform-admins
platformRouter.use((req, res, next) => {
  // If in production, strictly verify. In development, double-check req.auth exists.
  if (req.auth && !req.auth.user.is_platform_admin) {
    throw new HttpError(403, 'Acceso denegado: Se requieren privilegios de administrador de plataforma.');
  }
  next();
});

// GET all tenants (platform wide)
platformRouter.get('/tenants', asyncHandler(async (req, res) => {
  const tenants = await Tenant.findAll({
    include: [{ model: Plan, attributes: ['code', 'name'] }],
    order: [['name', 'ASC']],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  res.json({ data: tenants });
}));

// GET all users (platform wide)
platformRouter.get('/users', asyncHandler(async (req, res) => {
  const users = await User.findAll({
    attributes: ['id', 'email', 'full_name', 'status', 'is_platform_admin', 'created_at'],
    order: [['full_name', 'ASC']],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  res.json({ data: users });
}));

// PATCH tenant status / plan (Tenant master controls)
const updateTenantSchema = z.object({
  status: z.enum(['active', 'onboarding', 'suspended', 'archived']).optional(),
  plan_id: z.string().uuid().optional()
});

platformRouter.patch('/tenants/:id', asyncHandler(async (req, res) => {
  const parsed = updateTenantSchema.parse(req.body);
  const tenant = await Tenant.findByPk(req.params.id, { transaction: req.dbTransaction, skipTenantScope: true });
  if (!tenant) throw new HttpError(404, 'Tenant no encontrado.');

  await tenant.update(parsed, { transaction: req.dbTransaction, skipTenantScope: true });
  res.json({ data: tenant });
}));

// GET tenant modules settings (modules enabled)
platformRouter.get('/tenants/:id/modules', asyncHandler(async (req, res) => {
  const tenantId = req.params.id;
  const [allModules, enabledModules] = await Promise.all([
    Module.findAll({ order: [['name', 'ASC']], transaction: req.dbTransaction, skipTenantScope: true }),
    TenantModule.findAll({ where: { tenant_id: tenantId }, transaction: req.dbTransaction, skipTenantScope: true })
  ]);
  res.json({
    data: {
      modules: allModules,
      enabled: enabledModules.map(m => m.module_code)
    }
  });
}));

// POST enable/disable tenant modules
const toggleModuleSchema = z.object({
  module_code: z.string(),
  is_enabled: z.boolean()
});

platformRouter.post('/tenants/:id/modules', asyncHandler(async (req, res) => {
  const tenantId = req.params.id;
  const { module_code, is_enabled } = toggleModuleSchema.parse(req.body);

  const [moduleSetting, created] = await TenantModule.findOrCreate({
    where: { tenant_id: tenantId, module_code },
    defaults: { is_enabled, source: 'platform' },
    transaction: req.dbTransaction,
    skipTenantScope: true
  });

  if (!created) {
    await moduleSetting.update({ is_enabled, source: 'platform' }, { transaction: req.dbTransaction, skipTenantScope: true });
  }

  res.json({ data: moduleSetting });
}));

// GET all plans
platformRouter.get('/plans', asyncHandler(async (req, res) => {
  const plans = await Plan.findAll({
    order: [['name', 'ASC']],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  res.json({ data: plans });
}));
