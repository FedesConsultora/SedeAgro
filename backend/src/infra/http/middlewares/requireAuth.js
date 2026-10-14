import { Membership, Role, User } from '../../../models/index.js';
import { bearerToken } from '../../security/securityGuards.js';
import { setActorId } from '../../../core/tenantContext.js';
import { verifySession } from '../../../utils/jwt.js';
import { HttpError } from '../../../utils/http.js';

export async function requireAuth(req, _res, next) {
  try {
    const token = bearerToken(req.headers?.authorization);
    if (!token) throw new HttpError(401, 'Token requerido o encabezado Bearer inválido.');

    let payload;
    try {
      payload = verifySession(token);
    } catch {
      throw new HttpError(401, 'Token inválido o expirado.');
    }
    if (payload.tenant_id !== req.tenantId) {
      throw new HttpError(403, 'El token no corresponde al tenant activo.');
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

    req.auth = {
      user: membership.User,
      membership,
      role: membership.Role,
      tenant: req.tenant
    };
    setActorId(membership.User.id);

    next();
  } catch (error) {
    next(error);
  }
}
