import { sequelize, setLocalTenant } from '../../../core/db.js';
import { logger } from '../../../core/logger.js';
import { deferResponseUntilTransactionSettles } from './transactionalResponse.js';

export async function tenantTransaction(req, res, next) {
  if (!req.tenantId) return next();

  let transaction;
  try {
    transaction = await sequelize.transaction();
    await setLocalTenant(transaction, req.tenantId);
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
