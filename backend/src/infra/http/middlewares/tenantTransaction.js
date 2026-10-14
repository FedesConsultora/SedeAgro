import { sequelize, setLocalTenant } from '../../../core/db.js';

export async function tenantTransaction(req, res, next) {
  if (!req.tenantId) return next();

  let transaction;
  try {
    transaction = await sequelize.transaction();
    await setLocalTenant(transaction, req.tenantId);
  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback().catch(() => {});
    }
    return next(error);
  }

  req.dbTransaction = transaction;
  let completed = false;

  async function closeTransaction(event) {
    if (completed) return;
    completed = true;
    try {
      // A client disconnect must not commit work from an incomplete response.
      if (event === 'finish' && res.writableFinished && res.statusCode < 400) {
        await transaction.commit();
      } else {
        await transaction.rollback();
      }
    } catch (error) {
      // The response has already been sent or aborted, so log the error for investigation.
      console.error('tenant_transaction_finalize_failed', {
        request_id: req.requestId,
        event,
        message: error.message
      });
      if (!transaction.finished) await transaction.rollback().catch(() => {});
    }
  }

  res.once('finish', () => { void closeTransaction('finish'); });
  res.once('close', () => { void closeTransaction('close'); });

  next();
}
