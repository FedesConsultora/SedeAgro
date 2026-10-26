import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import {
  AuditEvent, AuthSession, MemberInvitation, Membership, Plan, Tenant, User
} from '../../models/index.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import {
  isManageableMembership, hasSeatForActivation, membershipStatusReceipt
} from './memberLifecyclePolicy.js';

export const memberLifecycleRouter = Router();

const statusSchema = z.object({ status: z.enum(['active', 'blocked']) }).strict();
const uuid = z.string().uuid();

memberLifecycleRouter.patch('/:membershipId/status',
  requireCapability('members.manage'),
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const parsed = uuid.safeParse(req.params.membershipId);
    if (!parsed.success) {
      throw new HttpError(422, 'Identificador de integrante inválido.',
        undefined, 'MEMBER_ID_INVALID');
    }
    const tx = req.dbTransaction;
    // Serialize seat accounting with invitation issuance/acceptance, which
    // lock the same tenant row before checking plan capacity.
    const tenant = await Tenant.findOne({
      where: { id: req.tenantId, status: { [Op.in]: ['active', 'onboarding'] } },
      attributes: ['id', 'plan_id'], transaction: tx, lock: tx.LOCK.UPDATE,
      skipTenantScope: true
    });
    if (!tenant) throw new HttpError(404, 'Empresa no disponible.', undefined, 'MEMBER_TENANT_MISSING');
    const member = await Membership.findOne({
      where: { id: parsed.data, tenant_id: tenant.id },
      transaction: tx, lock: tx.LOCK.UPDATE
    });
    if (!member) {
      throw new HttpError(404, 'Integrante no encontrado en esta empresa.',
        undefined, 'MEMBER_NOT_FOUND');
    }
    if (!isManageableMembership(member, req.auth.user.id, tenant.id)) {
      throw new HttpError(403, 'No podés cambiar el estado de esta membresía.',
        undefined, 'MEMBER_STATUS_FORBIDDEN');
    }
    const next = req.body.status;
    if (member.status === next) {
      res.json({ data: membershipStatusReceipt(member, false) });
      return;
    }

    if (next === 'active') {
      const user = await User.findByPk(member.user_id, {
        attributes: ['id', 'status'], transaction: tx, skipTenantScope: true
      });
      if (user?.status !== 'active') {
        throw new HttpError(409, 'La cuenta está inhabilitada y no puede reactivarse.',
          undefined, 'MEMBER_USER_BLOCKED');
      }
      const plan = await Plan.findByPk(tenant.plan_id, {
        attributes: ['max_users'], transaction: tx, skipTenantScope: true
      });
      const now = new Date();
      const [active, pending] = await Promise.all([
        Membership.count({ where: { tenant_id: tenant.id, status: 'active' },
          transaction: tx }),
        MemberInvitation.count({ where: { tenant_id: tenant.id, status: 'pending',
          expires_at: { [Op.gt]: now } }, transaction: tx })
      ]);
      if (!hasSeatForActivation({ active, pending, maxUsers: plan?.max_users })) {
        throw new HttpError(409, 'No hay cupos para reactivar este integrante.',
          undefined, 'MEMBER_SEATS_FULL');
      }
    }

    const previous = member.status;
    await member.update({ status: next }, { transaction: tx });
    if (next === 'blocked') {
      // AuthSession is persisted per tenant. Existing cookies/JWTs cannot
      // resurrect blocked access; revoked sessions stay revoked on reactivation.
      await AuthSession.update({ revoked_at: new Date() }, {
        where: { tenant_id: tenant.id, user_id: member.user_id, revoked_at: null },
        transaction: tx
      });
    }
    await AuditEvent.create({
      tenant_id: tenant.id, actor_id: req.auth.user.id,
      action: next === 'blocked' ? 'membership.suspended' : 'membership.reactivated',
      entity_type: 'membership', entity_id: member.id,
      before: { status: previous, role_code: member.role_code },
      after: { status: next, role_code: member.role_code }
    }, { transaction: tx });
    res.json({ data: membershipStatusReceipt(member, true) });
  })
);
