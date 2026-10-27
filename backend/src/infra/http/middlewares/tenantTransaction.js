import { sequelize, setLocalTenant } from '../../../core/db.js';
import { Tenant } from '../../../models/index.js';
import { HttpError } from '../../../utils/http.js';
import { lockTenantLifecycle } from '../../../core/tenantSuspensionFence.js';
import { logger } from '../../../core/logger.js';
import { deferResponseUntilTransactionSettles } from './transactionalResponse.js';

export async function tenantTransaction(req, res, next) {
  if (!req.tenantId) return next();

  let transaction;
  try {
    transaction = await sequelize.transaction();
    // Acquire a SHARED tenant-lifecycle lock before accepting any request
    // scoped to this company. Platform suspension takes EXCLUSIVE on the same
    // key, so no in-flight business operation can commit AFTER revocation.
    // Shared locks do not serialize independent reads/writes in one tenant.
    await lockTenantLifecycle(transaction, req.tenantId, 'shared');
    await setLocalTenant(transaction, req.tenantId);
    // tenantResolver's SELECT was outside this transaction. Recheck status
    // under the lifecycle fence; never trust a stale active-tenant snapshot.
    const liveTenant = await Tenant.findOne({
      where: { id: req.tenantId, status: ['active', 'onboarding'] },
      attributes: ['id', 'status'], transaction, skipTenantScope: true
    });
    if (!liveTenant) {
      throw new HttpError(403, 'Empresa suspendida o eliminada.',
        undefined, 'TENANT_DISABLED_DURING_REQUEST');
    }
  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback().catch((rollbackError) => {
        logger.error('db.tenant_transaction_setup_rollback_failed', {
          request_id: req.requestId,
          error: rollbackError
        });
      });
    }
    return next(error);
  }

  req.dbTransaction = transaction;
  // Commit BEFORE the response goes on the wire. Error/abort paths roll back.
  // Unsupported streaming attempts are rejected rather than committing prematurely.
  deferResponseUntilTransactionSettles(req, res, next, transaction, logger);
  next();
}
