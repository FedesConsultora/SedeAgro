import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Op } from 'sequelize';
import { sequelize, setLocalTenant, withTenantTransaction } from '../../core/db.js';
import {
  Membership,
  AuthSession,
  Plan,
  PlanModule,
  Tenant,
  TenantModule,
  User
} from '../../models/index.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { validatePasswordStrength } from '../../utils/password.js';
import { signSession, verifySession } from '../../utils/jwt.js';
import { clearSessionCookie, sessionCookie, wantsCookieSession } from '../../infra/security/sessionTransport.js';
import { HttpError, asyncHandler, validate } from '../../utils/http.js';
import { rateLimit } from '../../infra/http/middlewares/rateLimit.js';
import { reserveSessionSlot, MAX_ACTIVE_SESSIONS } from './sessionPolicy.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';

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

  await reserveSessionSlot({ userId: user.id, tenantId: membership.tenant_id, transaction });
  const id = randomUUID();
  const token = signSession({ ...sessionPayload(user, membership), jti: id });
  const signed = verifySession(token);
  await AuthSession.create({
    id,
    tenant_id: membership.tenant_id,
    user_id: user.id,
    expires_at: new Date(signed.exp * 1000)
  }, { transaction });

  return {
    token,
    user: { id: user.id, email: user.email, fullName: user.full_name, isPlatformAdmin: user.is_platform_admin },
    tenant,
    membership: { id: membership.id, roleCode: membership.role_code, status: membership.status },
    entitlements: modules.map((module) => module.module_code)
  };
}

function finishLogin(req, res, session, status = 200) {
  if (wantsCookieSession(req)) {
    res.setHeader('Set-Cookie', sessionCookie(session.token));
    const { token: _token, ...publicSession } = session;
    res.status(status).json(publicSession);
  } else {
    // Non-browser REST clients explicitly use Authorization: Bearer.
    res.status(status).json(session);
  }
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

    // TenantModule has FORCE RLS: even registration must activate the new tenant
    // inside its existing transaction before writing entitlement rows.
    await setLocalTenant(transaction, tenant.id);

    await TenantModule.bulkCreate(planModules.map((planModule) => ({
      tenant_id: tenant.id,
      module_code: planModule.module_code,
      is_enabled: true,
      source: 'plan'
    })), { transaction, skipTenantScope: true });

    return issueTenantSession(user, membership, transaction);
  });

  finishLogin(req, res, result, 201);
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

  // Login is a public route, so no request-level tenant transaction exists yet.
  // Read FORCE-RLS entitlements in an explicit transaction for the selected tenant.
  const session = await withTenantTransaction(
    (transaction) => issueTenantSession(user, selectedMembership, transaction),
    selectedMembership.tenant_id
  );
  finishLogin(req, res, session);
}));

authScopedRouter.post('/logout', asyncHandler(async (req, res) => {
  // Session row is protected by tenant RLS; revocation is visible to every
  // backend replica and takes effect on the next authenticated request.
  await AuthSession.update({ revoked_at: new Date() }, {
    where: { id: req.auth.session.id, user_id: req.auth.user.id, tenant_id: req.tenantId, revoked_at: null },
    transaction: req.dbTransaction
  });
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.status(204).end();
}));

// A user can inspect and revoke only their own live sessions in the active
// tenant. Never return bearer tokens, cookie values or session secrets.
authScopedRouter.get('/sessions', asyncHandler(async (req, res) => {
  const rows = await AuthSession.findAll({
    where: {
      tenant_id: req.tenantId, user_id: req.auth.user.id,
      revoked_at: null, expires_at: { [Op.gt]: new Date() }
    },
    attributes: ['id', 'created_at', 'expires_at'],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: MAX_ACTIVE_SESSIONS,
    transaction: req.dbTransaction
  });
  res.json({ data: rows.map((row) => ({
    id: row.id, createdAt: row.created_at, expiresAt: row.expires_at,
    isCurrent: row.id === req.auth.session?.id
  })), maxActiveSessions: MAX_ACTIVE_SESSIONS });
}));

authScopedRouter.delete('/sessions/:sessionId', asyncHandler(async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.sessionId);
  if (!parsed.success) throw new HttpError(422, 'Identificador de sesión inválido.');
  if (!req.auth.session) throw new HttpError(401, 'La sesión debe estar registrada.');
  if (parsed.data === req.auth.session.id) {
    throw new HttpError(409, 'Para cerrar esta sesión utilizá Cerrar sesión.');
  }
  const [count] = await AuthSession.update({ revoked_at: new Date() }, {
    where: {
      id: parsed.data, tenant_id: req.tenantId,
      user_id: req.auth.user.id, revoked_at: null,
      expires_at: { [Op.gt]: new Date() }
    },
    transaction: req.dbTransaction
  });
  if (count === 0) throw new HttpError(404, 'Sesión no encontrada o ya finalizada.');
  res.status(204).end();
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
    membership: { id: req.auth.membership.id, roleCode: req.auth.membership.role_code, status: req.auth.membership.status },
    entitlements: modules.map((module) => module.module_code)
  });
}));

authScopedRouter.get('/members', requireCapability('members.read'), asyncHandler(async (req, res) => {
  const memberships = await Membership.findAll({
    where: { tenant_id: req.tenantId },
    include: [{ model: User, attributes: ['id', 'email', 'full_name', 'status', 'is_platform_admin'] }],
    order: [[User, 'full_name', 'ASC']],
    transaction: req.dbTransaction,
    skipTenantScope: true
  });
  res.json({ data: memberships });
}));

