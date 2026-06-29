import { sequelize, setLocalTenant } from '../../../core/db.js';

export async function tenantTransaction(req, res, next) {
  if (!req.tenantId) return next();

  const transaction = await sequelize.transaction();
  req.dbTransaction = transaction;

  try {
    await setLocalTenant(transaction, req.tenantId);
  } catch (error) {
    await transaction.rollback();
    return next(error);
  }

  let completed = false;

  async function closeTransaction() {
    if (completed) return;
    completed = true;
    try {
      if (res.statusCode >= 400) await transaction.rollback();
      else await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => {});
    }
  }

  res.once('finish', closeTransaction);
  res.once('close', closeTransaction);

  next();
}
