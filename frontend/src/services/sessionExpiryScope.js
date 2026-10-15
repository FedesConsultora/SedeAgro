import { sessionScope } from './offlineSyncModel.js';

// A 401 is only allowed to invalidate the exact authenticated incarnation
// that started the request. Tenant/user alone is NOT enough: logging out
// and back into the same account starts a different incarnation.
export function isCurrentSessionExpiry(detail, currentSession, currentEpoch) {
  const scope = sessionScope(currentSession);
  return Boolean(scope &&
    detail && typeof detail === 'object' &&
    detail.scope === scope &&
    Number.isSafeInteger(detail.epoch) && detail.epoch > 0 &&
    Number.isSafeInteger(currentEpoch) &&
    detail.epoch === currentEpoch);
}
