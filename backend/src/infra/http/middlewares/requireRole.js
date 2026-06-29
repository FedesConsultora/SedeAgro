import { HttpError } from '../../../utils/http.js';

export function requireRole(...roleCodes) {
  return (req, _res, next) => {
    if (!roleCodes.includes(req.auth?.role?.code)) {
      return next(new HttpError(403, 'No tenés permisos suficientes para esta acción.'));
    }
    next();
  };
}
