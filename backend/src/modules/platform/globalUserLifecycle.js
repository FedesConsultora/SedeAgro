import { Router } from 'express';
import { z } from 'zod';
import { AuthSession, Membership, PlatformAuditLog, User } from '../../models/index.js';
import { setLocalTenant } from '../../core/db.js';
import { isPlatformAdministrator } from '../../infra/security/securityGuards.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { globalUserStatusDecision } from './globalUserStatusPolicy.js';

export const globalUserLifecycleRouter = Router();
const statusSchema = z.object({ status: z.enum(['active', 'blocked']) }).strict();
const uuid = z.string().uuid();

globalUserLifecycleRouter.patch('/:userId/status', validate(statusSchema),
  asyncHandler(async (req, res) => {
    // Defense-in-depth: the parent platformRouter also requires the privileged
    // principal before allowing any platform operation.
    if (!isPlatformAdministrator(req.auth)) {
      throw new HttpError(403, 'No autorizado para gestionar cuentas globales.');
    }
    const parsed = uuid.safeParse(req.params.userId);
    if (!parsed.success) {
      throw new HttpError(422, 'Usuario inválido.', undefined, 'PLATFORM_USER_ID_INVALID');
    }
    const transaction = req.dbTransaction;
    const target = await User.findByPk(parsed.data, {
      attributes: ['id', 'status', 'is_platform_admin'],
      transaction, lock: transaction.LOCK.UPDATE, skipTenantScope: true
    });
    if (!target) {
      throw new HttpError(404, 'Usuario no encontrado.', undefined, 'PLATFORM_USER_NOT_FOUND');
    }

    const decision = globalUserStatusDecision(req.auth.user, target, req.body.status);
    if (!decision.allowed) {
      const code = decision.code;
      const status = code === 'PLATFORM_USER_DELETED' ||
        code === 'PLATFORM_USER_STATUS_UNSUPPORTED' ? 409 : 403;
      throw new HttpError(status, 'El estado global de esta cuenta no puede modificarse.',
        undefined, code);
    }

    const previous = target.status;
    const next = req.body.status;
    const now = new Date();
    // The user row lock serializes this change against reserveSessionSlot's
    // SELECT FOR UPDATE. Existing sessions in ALL tenant memberships are
    // revoked before releasing that lock and before sending the HTTP ACK.
    if (decision.changed) {
      await target.update({ status: next }, { transaction, skipTenantScope: true });
    }

    let revokedSessions = 0;
    if (next === 'blocked') {
      // memberships currently remains global for public multiempresa login.
      // This is a *platform-admin-only*, DB-row-locked enumeration, not an
      // untrusted tenant API read and not an assertion of membership FORCE RLS.
      const memberships = await Membership.findAll({
        where: { user_id: target.id }, attributes: ['tenant_id'],
        transaction, skipTenantScope: true
      });
      const tenants = [...new Set(memberships.map(row => row.tenant_id))];
      try {
        for (const tenantId of tenants) {
          await setLocalTenant(transaction, tenantId);
          const [count] = await AuthSession.update({ revoked_at: now }, {
            where: { tenant_id: tenantId, user_id: target.id, revoked_at: null },
            transaction
          });
          revokedSessions += count;
        }
      } finally {
        // Never leave the caller's transaction scoped to another company.
        await setLocalTenant(transaction, req.tenantId);
      }
    }

    if (decision.changed || revokedSessions > 0) {
      await PlatformAuditLog.create({
        actor_id: req.auth.user.id,
        action: 'platform.user.global_status_changed',
        payload: {
          user_id: target.id, previous_status: previous,
          next_status: next, revoked_sessions: revokedSessions
        }
      }, { transaction });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: {
      id: target.id, status: next, changed: decision.changed, revokedSessions
    } });
  })
);
