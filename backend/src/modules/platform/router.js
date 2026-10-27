import { Router } from 'express';
import { z } from 'zod';
import { setLocalTenant } from '../../core/db.js';
import { lockTenantLifecycle } from '../../core/tenantSuspensionFence.js';
import { AuthSession, PlatformAuditLog, Tenant, User, Plan, TenantModule, Module } from '../../models/index.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { isPlatformAdministrator } from '../../infra/security/securityGuards.js';
import { globalUserLifecycleRouter } from './globalUserLifecycle.js';
import { planTenantStatusChange } from './tenantStatusPolicy.js';

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

// Audited global user suspension (with all-tenant session invalidation).
// Platform-only middleware above runs before this nested router.
platformRouter.use('/users', globalUserLifecycleRouter);

// PATCH tenant status / plan (Tenant master controls)
const tenantIdParams = z.object({ id: z.string().uuid() });

const updateTenantSchema = z.object({
  status: z.enum(['active', 'onboarding', 'suspended', 'deleted']).optional(),
  plan_id: z.string().uuid().optional()
}).strict().refine(value => value.status !== undefined || value.plan_id !== undefined,
  'Informá el estado o plan que querés modificar.');

platformRouter.patch('/tenants/:id', validate(tenantIdParams, 'params'), asyncHandler(async (req, res) => {
  const parsed = updateTenantSchema.parse(req.body);
  const transaction = req.dbTransaction;
  // The authenticated platform request already owns a SHARED lock on its
  // home tenant. For a DIFFERENT target tenant, take EXCLUSIVE before its row
  // UPDATE and session revocations. This pairs with the transaction fence
  // held by every scoped business request, on every backend replica.
  // Self-suspension/deletion is separately rejected by status policy; a
  // same-tenant plan change keeps its existing shared lock and row lock.
  if (req.params.id !== req.tenantId && parsed.status !== undefined) {
    await lockTenantLifecycle(transaction, req.params.id, 'exclusive');
  }
  // Serialize tenant disable/enable/plan transitions with membership
  // invitation/lifecycle operations, which also lock the tenant row.
  const tenant = await Tenant.findByPk(req.params.id, {
    attributes: ['id', 'plan_id', 'status', 'name', 'slug'],
    transaction, lock: transaction.LOCK.UPDATE, skipTenantScope: true
  });
  if (!tenant) throw new HttpError(404, 'Tenant no encontrado.');

  const decision = planTenantStatusChange({
    actorTenantId: req.tenantId, targetTenantId: tenant.id,
    previousStatus: tenant.status, nextStatus: parsed.status,
    planChangeRequested: parsed.plan_id !== undefined
  });
  if (!decision.allowed) {
    throw new HttpError(409, 'No se permite esta transición de empresa.',
      undefined, decision.code);
  }
  const before = { status: tenant.status, plan_id: tenant.plan_id };
  const nextStatus = parsed.status ?? tenant.status;
  const nextPlanId = parsed.plan_id ?? tenant.plan_id;
  const changed = before.status !== nextStatus || before.plan_id !== nextPlanId;
  if (changed) {
    await tenant.update(parsed, { transaction, skipTenantScope: true });
  }

  // A suspended/deleted company may later be reactivated. Existing signed
  // sessions MUST NOT resurrect; invalidate them transactionally BEFORE ACK.
  // forTargetTenant only switches the current transaction GUC and restores it
  // in finally, so existing auth_sessions FORCE RLS stays enforced.
  let revokedSessions = 0;
  if (decision.revokeSessions) {
    revokedSessions = await forTargetTenant(req, tenant.id, async () => {
      const [count] = await AuthSession.update({ revoked_at: new Date() }, {
        where: { tenant_id: tenant.id, revoked_at: null }, transaction
      });
      return count;
    });
  }

  if (changed || revokedSessions > 0) {
    await PlatformAuditLog.create({
      actor_id: req.auth.user.id,
      tenant_id: tenant.id,
      action: 'platform.tenant.lifecycle_updated',
      payload: {
        before, after: { status: tenant.status, plan_id: tenant.plan_id },
        revoked_sessions: revokedSessions
      }
    }, {
      transaction,
      // The global ALS tenant hook defaults to the platform admin's HOME
      // tenant. This event belongs to the TARGET tenant; do not overwrite it.
      skipTenantScope: true
    });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ data: tenant, changed, revokedSessions });
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
