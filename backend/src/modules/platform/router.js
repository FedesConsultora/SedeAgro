import { Router } from 'express';
import { z } from 'zod';
import { setLocalTenant } from '../../core/db.js';
import { Tenant, User, Plan, TenantModule, Module, Membership } from '../../models/index.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { isPlatformAdministrator } from '../../infra/security/securityGuards.js';

export const platformRouter = Router();

async function forTargetTenant(req, tenantId, operation) {
  const target = await Tenant.findByPk(tenantId, {
    attributes: ['id'],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  if (!target) throw new HttpError(404, 'Tenant no encontrado.');
  if (tenantId === req.tenantId) return operation();
  // The platform route is already authenticated and restricted to platform admins.
  // Switch the current transaction's RLS scope temporarily without creating an
  // independently committing second transaction.
  await setLocalTenant(req.dbTransaction, tenantId);
  try {
    return await operation();
  } finally {
    await setLocalTenant(req.dbTransaction, req.tenantId);
  }
}


// Fail closed for missing principals and non-platform administrators in all environments.
platformRouter.use((req, _res, next) => {
  if (!isPlatformAdministrator(req.auth)) {
    return next(new HttpError(403, 'Acceso denegado: Se requieren privilegios de administrador de plataforma.'));
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
const tenantIdParams = z.object({ id: z.string().uuid() });

const updateTenantSchema = z.object({
  status: z.enum(['active', 'onboarding', 'suspended', 'deleted']).optional(),
  plan_id: z.string().uuid().optional()
});

platformRouter.patch('/tenants/:id', validate(tenantIdParams, 'params'), asyncHandler(async (req, res) => {
  const parsed = updateTenantSchema.parse(req.body);
  const tenant = await Tenant.findByPk(req.params.id, { transaction: req.dbTransaction, skipTenantScope: true });
  if (!tenant) throw new HttpError(404, 'Tenant no encontrado.');

  await tenant.update(parsed, { transaction: req.dbTransaction, skipTenantScope: true });
  res.json({ data: tenant });
}));

// GET tenant modules settings (modules enabled)
platformRouter.get('/tenants/:id/modules', validate(tenantIdParams, 'params'), asyncHandler(async (req, res) => {
  const tenantId = req.params.id;
  const allModules = await Module.findAll({
    order: [['name', 'ASC']],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  const enabledModules = await forTargetTenant(req, tenantId, () => TenantModule.findAll({
    where: { tenant_id: tenantId, is_enabled: true },
    transaction: req.dbTransaction,
    skipTenantScope: true
  }));
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

platformRouter.post('/tenants/:id/modules', validate(tenantIdParams, 'params'), asyncHandler(async (req, res) => {
  const tenantId = req.params.id;
  const { module_code, is_enabled } = toggleModuleSchema.parse(req.body);

  const module = await Module.findByPk(module_code, {
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  if (!module) throw new HttpError(422, 'Módulo desconocido.');

  const moduleSetting = await forTargetTenant(req, tenantId, async () => {
    const [setting, created] = await TenantModule.findOrCreate({
      where: { tenant_id: tenantId, module_code },
      defaults: { is_enabled, source: 'override' },
      transaction: req.dbTransaction,
      skipTenantScope: true
    });
    if (!created) {
      await setting.update({ is_enabled, source: 'override' }, {
        transaction: req.dbTransaction,
        skipTenantScope: true
      });
    }
    return setting;
  });

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
