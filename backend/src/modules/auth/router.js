import { Router } from 'express';
import { z } from 'zod';
import { sequelize } from '../../core/db.js';
import {
  Membership,
  Plan,
  PlanModule,
  Tenant,
  TenantModule,
  User
} from '../../models/index.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { validatePasswordStrength } from '../../utils/password.js';
import { signSession } from '../../utils/jwt.js';
import { HttpError, asyncHandler, validate } from '../../utils/http.js';
import { rateLimit } from '../../infra/http/middlewares/rateLimit.js';

export const authPublicRouter = Router();
export const authScopedRouter = Router();

const registerTenantSchema = z.object({
  organizationName: z.string().min(2).max(180),
  slug: z.string().min(3).max(90).regex(/^[a-z0-9-]+$/),
  billingEmail: z.string().email().optional(),
  fullName: z.string().min(2).max(180),
  email: z.string().email(),
  password: z.string().min(12),
  planCode: z.string().default('starter')
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().uuid().optional(),
  tenantSlug: z.string().optional()
});

function sessionPayload(user, membership) {
  return {
    sub: user.id,
    tenant_id: membership.tenant_id,
    role_code: membership.role_code
  };
}

async function issueTenantSession(user, membership, transaction) {
  const tenant = await Tenant.findByPk(membership.tenant_id, {
    attributes: ['id', 'name', 'slug', 'status'],
    transaction,
    skipTenantScope: true
  });

  const modules = await TenantModule.findAll({
    where: { tenant_id: tenant.id, is_enabled: true },
    attributes: ['module_code'],
    transaction,
    skipTenantScope: true
  });

  return {
    token: signSession(sessionPayload(user, membership)),
    user: { id: user.id, email: user.email, fullName: user.full_name, isPlatformAdmin: user.is_platform_admin },
    tenant,
    membership: { id: membership.id, roleCode: membership.role_code, status: membership.status },
    entitlements: modules.map((module) => module.module_code)
  };
}

authPublicRouter.post('/register-tenant', rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: 'register-tenant' }), validate(registerTenantSchema), asyncHandler(async (req, res) => {
  const payload = req.body;
  validatePasswordStrength(payload.password, [payload.email, payload.fullName, payload.organizationName]);

  const result = await sequelize.transaction(async (transaction) => {
    const plan = await Plan.findOne({
      where: { code: payload.planCode, is_active: true },
      transaction,
      skipTenantScope: true
    });
    if (!plan) throw new HttpError(422, 'Plan no disponible.');

    const existingUser = await User.findOne({
      where: { email: payload.email },
      transaction,
      skipTenantScope: true
    });
    if (existingUser) throw new HttpError(409, 'Ya existe un usuario con ese email.');

    const user = await User.create({
      email: payload.email,
      full_name: payload.fullName,
      password_hash: await hashPassword(payload.password)
    }, { transaction, skipTenantScope: true });

    const tenant = await Tenant.create({
      name: payload.organizationName,
      slug: payload.slug,
      billing_email: payload.billingEmail || payload.email,
      plan_id: plan.id,
      status: 'active'
    }, { transaction, skipTenantScope: true });

    const membership = await Membership.create({
      tenant_id: tenant.id,
      user_id: user.id,
      role_code: 'tenant_admin',
      status: 'active',
      joined_at: new Date()
    }, { transaction, skipTenantScope: true });

    const planModules = await PlanModule.findAll({
      where: { plan_id: plan.id },
      transaction,
      skipTenantScope: true
    });

    await TenantModule.bulkCreate(planModules.map((planModule) => ({
      tenant_id: tenant.id,
      module_code: planModule.module_code,
      is_enabled: true,
      source: 'plan'
    })), { transaction, skipTenantScope: true });

    return issueTenantSession(user, membership, transaction);
  });

  res.status(201).json(result);
}));

authPublicRouter.post('/login', rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: 'login' }), validate(loginSchema), asyncHandler(async (req, res) => {
  const { email, password, tenantId, tenantSlug } = req.body;

  const user = await User.findOne({
    where: { email },
    skipTenantScope: true
  });
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, 'Email o contraseña incorrectos.');
  }

  const memberships = await Membership.findAll({
    where: { user_id: user.id, status: 'active' },
    include: [{ model: Tenant, attributes: ['id', 'name', 'slug', 'status'] }],
    skipTenantScope: true
  });

  const activeMemberships = memberships.filter((membership) => ['onboarding', 'active'].includes(membership.Tenant.status));
  if (!activeMemberships.length) throw new HttpError(403, 'No tenés membresías activas.');

  const selectedMembership = tenantId || tenantSlug
    ? activeMemberships.find((membership) => membership.tenant_id === tenantId || membership.Tenant.slug === tenantSlug)
    : activeMemberships.length === 1 ? activeMemberships[0] : null;

  if (!selectedMembership) {
    res.json({
      requiresTenantSelection: true,
      memberships: activeMemberships.map((membership) => ({
        tenantId: membership.tenant_id,
        tenantName: membership.Tenant.name,
        tenantSlug: membership.Tenant.slug,
        roleCode: membership.role_code
      }))
    });
    return;
  }

  res.json(await issueTenantSession(user, selectedMembership, req.dbTransaction));
}));

authScopedRouter.get('/me', asyncHandler(async (req, res) => {
  const modules = await TenantModule.findAll({
    where: { tenant_id: req.tenantId, is_enabled: true },
    attributes: ['module_code'],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });

  res.json({
    user: {
      id: req.auth.user.id,
      email: req.auth.user.email,
      fullName: req.auth.user.full_name,
      isPlatformAdmin: req.auth.user.is_platform_admin
    },
    tenant: req.tenant,
    role: req.auth.role,
    entitlements: modules.map((module) => module.module_code)
  });
}));

authScopedRouter.get('/members', asyncHandler(async (req, res) => {
  const memberships = await Membership.findAll({
    where: { tenant_id: req.tenantId },
    include: [{ model: User, attributes: ['id', 'email', 'full_name', 'status', 'is_platform_admin'] }],
    order: [[User, 'full_name', 'ASC']],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  res.json({ data: memberships });
}));

