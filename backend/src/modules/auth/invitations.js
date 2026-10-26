import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { withTenantTransaction } from '../../core/db.js';
import { AuditEvent, MemberInvitation, Membership, Plan, Tenant, User } from '../../models/index.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../../utils/password.js';
import { rateLimit } from '../../infra/http/middlewares/rateLimit.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import {
  hasMemberCapacity, invitationPublicShape, invitationTokenIdentity,
  INVITATION_TTL_MS, isInvitableRole, newInvitationToken, normalizeInvitationEmail
} from './memberInvitationPolicy.js';

export const invitationPublicRouter = Router();
export const invitationScopedRouter = Router();

const inviteSchema = z.object({
  email: z.string().trim().email().max(320).transform(normalizeInvitationEmail),
  roleCode: z.enum(['scout', 'contractor', 'agronomic_coordinator', 'producer_viewer'])
}).strict();

const acceptSchema = z.object({
  token: z.string().min(1).max(110),
  password: z.string().min(1).max(512),
  fullName: z.string().trim().min(2).max(180).optional()
}).strict();

const opaqueTokenError = () => new HttpError(404, 'Invitación no encontrada o no válida.',
  undefined, 'INVITATION_NOT_FOUND');

async function lockActiveTenant(tenantId, transaction) {
  const tenant = await Tenant.findOne({
    where: { id: tenantId, status: { [Op.in]: ['active', 'onboarding'] } },
    attributes: ['id', 'name', 'slug', 'plan_id'],
    transaction,
    lock: transaction.LOCK.UPDATE,
    skipTenantScope: true
  });
  if (!tenant) throw opaqueTokenError();
  return tenant;
}

async function seatCounts(tenantId, now, transaction) {
  const [active, pending] = await Promise.all([
    Membership.count({
      where: { tenant_id: tenantId, status: 'active' },
      transaction
    }),
    MemberInvitation.count({
      where: { tenant_id: tenantId, status: 'pending', expires_at: { [Op.gt]: now } },
      transaction
    })
  ]);
  return { active, pending };
}

async function assertSeatAvailable(tenant, now, transaction) {
  const plan = await Plan.findByPk(tenant.plan_id, {
    attributes: ['max_users'], transaction, skipTenantScope: true
  });
  if (!plan) throw new HttpError(409, 'Plan de la empresa no disponible.',
    undefined, 'MEMBER_PLAN_MISSING');
  const { active, pending } = await seatCounts(tenant.id, now, transaction);
  if (!hasMemberCapacity(active, pending, plan.max_users)) {
    throw new HttpError(409, 'Se alcanzó el máximo de integrantes o invitaciones del plan.',
      undefined, 'MEMBER_SEATS_FULL');
  }
}

async function recordInvitationAudit({ transaction, tenantId, actorId, invitation, action }) {
  await AuditEvent.create({
    tenant_id: tenantId, actor_id: actorId,
    action, entity_type: 'member_invitation', entity_id: invitation.id,
    after: { role_code: invitation.role_code, status: invitation.status }
  }, { transaction });
}

// Scoped routes are mounted after requireAuth, tenantResolver and FORCE-RLS
// tenantTransaction. Only tenant_admin currently has members.invite capability.
invitationScopedRouter.post('/',
  requireCapability('members.invite'),
  rateLimit({ windowMs: 10 * 60 * 1000, max: 12, keyPrefix: 'member-invite' }),
  validate(inviteSchema),
  asyncHandler(async (req, res) => {
    const now = new Date();
    const transaction = req.dbTransaction;
    const tenant = await lockActiveTenant(req.tenantId, transaction);
    // Expired pending rows are not usable, but must be retired to free the
    // unique pending-email slot before issuing a fresh invitation.
    await MemberInvitation.update({ status: 'revoked', revoked_at: now }, {
      where: { tenant_id: tenant.id, email: req.body.email,
        status: 'pending', expires_at: { [Op.lte]: now } },
      transaction
    });
    const pending = await MemberInvitation.findOne({
      where: { tenant_id: tenant.id, email: req.body.email, status: 'pending' },
      attributes: ['id'], transaction
    });
    if (pending) throw new HttpError(409, 'Ya existe una invitación pendiente para este email.',
      undefined, 'INVITATION_ALREADY_PENDING');

    // Never disclose membership in a foreign tenant. Local members cannot be
    // reactivated by a fresh invite: revocation must use an audited workflow.
    const knownUser = await User.findOne({
      where: { email: req.body.email }, attributes: ['id'], transaction,
      skipTenantScope: true
    });
    if (knownUser) {
      const local = await Membership.findOne({
        where: { tenant_id: tenant.id, user_id: knownUser.id },
        attributes: ['id'], transaction
      });
      if (local) throw new HttpError(409, 'Esta cuenta ya pertenece a esta empresa.',
        undefined, 'MEMBER_ALREADY_EXISTS');
    }
    await assertSeatAvailable(tenant, now, transaction);
    const token = newInvitationToken(tenant.id);
    const identity = invitationTokenIdentity(token);
    const invitation = await MemberInvitation.create({
      tenant_id: tenant.id, email: req.body.email,
      role_code: req.body.roleCode, token_hash: identity.tokenHash,
      expires_at: new Date(now.getTime() + INVITATION_TTL_MS),
      invited_by: req.auth.user.id
    }, { transaction });
    await recordInvitationAudit({ transaction, tenantId: tenant.id,
      actorId: req.auth.user.id, invitation, action: 'member_invitation.created' });

    // Explicitly manual: no email was sent. Show the secret once only to the
    // authorized administrator, never in list responses or persisted plaintext.
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      data: invitationPublicShape(invitation),
      delivery: { channel: 'manual', delivered: false, token }
    });
  })
);

invitationScopedRouter.get('/', requireCapability('members.invite'), asyncHandler(async (req, res) => {
  const rows = await MemberInvitation.findAll({
    where: { tenant_id: req.tenantId }, transaction: req.dbTransaction,
    attributes: ['id', 'email', 'role_code', 'status', 'expires_at', 'created_at'],
    order: [['created_at', 'DESC'], ['id', 'DESC']], limit: 100
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: rows.map(invitationPublicShape) });
}));

invitationScopedRouter.delete('/:invitationId',
  requireCapability('members.invite'),
  asyncHandler(async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.invitationId);
    if (!parsed.success) throw opaqueTokenError();
    const transaction = req.dbTransaction;
    await lockActiveTenant(req.tenantId, transaction);
    const invitation = await MemberInvitation.findOne({
      where: { id: parsed.data, tenant_id: req.tenantId, status: 'pending' },
      transaction, lock: transaction.LOCK.UPDATE
    });
    if (!invitation) throw opaqueTokenError();
    await invitation.update({ status: 'revoked', revoked_at: new Date() }, { transaction });
    await recordInvitationAudit({ transaction, tenantId: req.tenantId,
      actorId: req.auth.user.id, invitation, action: 'member_invitation.revoked' });
    res.status(204).end();
  })
);

invitationPublicRouter.post('/accept',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: 'member-accept' }),
  validate(acceptSchema),
  asyncHandler(async (req, res) => {
    const identity = invitationTokenIdentity(req.body.token);
    if (!identity) throw opaqueTokenError();
    const result = await withTenantTransaction(async transaction => {
      const tenant = await lockActiveTenant(identity.tenantId, transaction);
      // The hash lookup is inside tenant RLS, and the tenant lock also
      // serializes capacity checks against new invitations and acceptances.
      const invitation = await MemberInvitation.findOne({
        where: { tenant_id: tenant.id, token_hash: identity.tokenHash },
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!invitation) throw opaqueTokenError();
      if (invitation.status !== 'pending' || invitation.expires_at <= new Date()) {
        throw new HttpError(410, 'La invitación ya no está disponible.',
          undefined, 'INVITATION_UNAVAILABLE');
      }
      if (!isInvitableRole(invitation.role_code)) {
        throw new HttpError(422, 'Rol de invitación no permitido.', undefined, 'INVITATION_ROLE_INVALID');
      }
      let user = await User.findOne({
        where: { email: invitation.email }, transaction, skipTenantScope: true
      });
      if (user) {
        // An invite alone must never reset or take over an existing account.
        if (user.status !== 'active' ||
            !(await verifyPassword(req.body.password, user.password_hash))) {
          throw new HttpError(422, 'No se pudo activar la invitación con esas credenciales.',
            undefined, 'INVITATION_CREDENTIALS_INVALID');
        }
      } else {
        if (!req.body.fullName) {
          throw new HttpError(422, 'Ingresá tu nombre para crear la cuenta.',
            undefined, 'INVITATION_NAME_REQUIRED');
        }
        validatePasswordStrength(req.body.password, [invitation.email, req.body.fullName]);
        user = await User.create({
          email: invitation.email, full_name: req.body.fullName,
          password_hash: await hashPassword(req.body.password)
        }, { transaction, skipTenantScope: true });
      }
      const already = await Membership.findOne({
        where: { tenant_id: tenant.id, user_id: user.id }, transaction
      });
      if (already) throw new HttpError(409, 'No se pudo activar esta invitación.',
        undefined, 'INVITATION_MEMBERSHIP_CONFLICT');
      const plan = await Plan.findByPk(tenant.plan_id, {
        attributes: ['max_users'], transaction, skipTenantScope: true
      });
      const active = await Membership.count({
        where: { tenant_id: tenant.id, status: 'active' }, transaction
      });
      // The accepting invite already reserves one seat. Do not count it twice,
      // but do reject if the tenant's plan was reduced after invitation.
      if (!Number.isSafeInteger(plan?.max_users) || active >= plan.max_users) {
        throw new HttpError(409, 'El plan no tiene cupos libres.', undefined, 'MEMBER_SEATS_FULL');
      }
      const membership = await Membership.create({
        tenant_id: tenant.id, user_id: user.id, role_code: invitation.role_code,
        status: 'active', is_bot: false, invited_by: invitation.invited_by,
        joined_at: new Date()
      }, { transaction });
      await invitation.update({ status: 'accepted', accepted_by: user.id, accepted_at: new Date() },
        { transaction });
      await recordInvitationAudit({ transaction, tenantId: tenant.id,
        actorId: user.id, invitation, action: 'member_invitation.accepted' });
      return { id: membership.id, roleCode: membership.role_code,
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } };
    }, identity.tenantId);
    res.setHeader('Cache-Control', 'no-store');
    // Recipient now logs in normally with their own password; no bearer token
    // is minted or exposed before login's normal session safeguards run.
    res.status(201).json({ data: result, next: 'login' });
  })
);
