import { AuthSession, Membership, Role, User } from '../../../models/index.js';
import { resolveAuthToken, requireCookieMutationHeader } from '../../security/sessionTransport.js';
import { setActorId } from '../../../core/tenantContext.js';
import { verifySession } from '../../../utils/jwt.js';
import { HttpError } from '../../../utils/http.js';
import { env } from '../../../config/env.js';

export async function requireAuth(req, _res, next) {
  try {
    const { token, transport } = resolveAuthToken(req);
    if (!token) throw new HttpError(401, 'Sesión requerida o token Bearer inválido.');

    let payload;
    try {
      payload = verifySession(token);
    } catch {
      throw new HttpError(401, 'Sesión inválida o expirada.');
    }
    if (payload.tenant_id !== req.tenantId) {
      throw new HttpError(403, 'El token no corresponde al tenant activo.');
    }

    let persistedSession = null;
    if (payload.jti) {
      persistedSession = await AuthSession.findOne({
        where: { id: payload.jti, tenant_id: req.tenantId, user_id: payload.sub, revoked_at: null },
        transaction: req.dbTransaction
      });
      if (!persistedSession || new Date(persistedSession.expires_at).getTime() <= Date.now()) {
        throw new HttpError(401, 'La sesión fue revocada o expiró.');
      }
    } else if (env.nodeEnv !== 'test') {
      // A temporary test-only exception allows older DB fixtures that sign
      // synthetic JWTs. Production and development require persisted sessions.
      throw new HttpError(401, 'La sesión requiere volver a iniciar sesión.');
    }

    const membership = await Membership.findOne({
      where: {
        tenant_id: req.tenantId,
        user_id: payload.sub,
        status: 'active'
      },
      include: [
        { model: User, attributes: ['id', 'email', 'full_name', 'status', 'is_platform_admin'] },
        { model: Role, attributes: ['code', 'name', 'scope'] }
      ],
      transaction: req.dbTransaction,
      skipTenantScope: true
    });

    if (!membership || membership.User.status !== 'active') {
      throw new HttpError(401, 'Sesión inválida o usuario bloqueado.');
    }

    req.authTransport = transport;
    req.auth = {
      user: membership.User,
      membership,
      role: membership.Role,
      tenant: req.tenant,
      session: persistedSession
    };
    requireCookieMutationHeader(req);
    setActorId(membership.User.id);
    next();
  } catch (error) {
    next(error);
  }
}
