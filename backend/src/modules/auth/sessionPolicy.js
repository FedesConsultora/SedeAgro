import { Op } from 'sequelize';
import { AuthSession, User } from '../../models/index.js';
import { HttpError } from '../../utils/http.js';
import { canIssueLoginForGlobalAccount } from './loginAccountPolicy.js';

// A hard per-user/per-tenant bound. Locking the global user row serializes
// simultaneous logins on different API replicas before inspecting live sessions.
export const MAX_ACTIVE_SESSIONS = 5;

export async function reserveSessionSlot({ userId, tenantId, transaction, now = new Date() }) {
  if (!userId || !tenantId || !transaction) throw new Error('A tenant transaction is required.');
  const owner = await User.findByPk(userId, {
    transaction, lock: transaction.LOCK.UPDATE,
    attributes: ['id', 'status'], skipTenantScope: true
  });
  // The password check and global status check on the public login route
  // precede this transaction. Recheck AFTER locking the user: an account
  // could have been disabled in the meantime by platform administration.
  // Reject before any existing session is evicted or a JWT is persisted.
  if (!canIssueLoginForGlobalAccount(owner)) {
    throw new HttpError(401, 'Email o contraseña incorrectos.');
  }

  const active = await AuthSession.findAll({
    where: {
      user_id: userId, tenant_id: tenantId, revoked_at: null,
      expires_at: { [Op.gt]: now }
    },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
    attributes: ['id'],
    transaction
  });
  const excess = active.length - MAX_ACTIVE_SESSIONS + 1;
  if (excess > 0) {
    await AuthSession.update({ revoked_at: now }, {
      where: {
        tenant_id: tenantId, user_id: userId, revoked_at: null,
        id: { [Op.in]: active.slice(0, excess).map((session) => session.id) }
      },
      transaction
    });
  }
}
