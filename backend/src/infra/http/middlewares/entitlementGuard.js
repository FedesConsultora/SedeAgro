import { TenantModule } from '../../../models/index.js';
import { HttpError } from '../../../utils/http.js';

export function requireEntitlement(moduleCode) {
  return async (req, _res, next) => {
    try {
      const enabled = await TenantModule.findOne({
        where: {
          tenant_id: req.tenantId,
          module_code: moduleCode,
          is_enabled: true
        },
        transaction: req.dbTransaction,
        skipTenantScope: true
      });

      if (!enabled) throw new HttpError(403, `El módulo ${moduleCode} no está habilitado para este tenant.`);
      next();
    } catch (error) {
      next(error);
    }
  };
}
