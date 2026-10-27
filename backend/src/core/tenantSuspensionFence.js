// Cross-replica tenant lifecycle fence. A transaction-scoped PostgreSQL
// advisory lock is released on COMMIT/ROLLBACK (including aborted HTTPs).
// All scoped requests take a SHARED lock; a platform suspension takes EXCLUSIVE
// for its target before changing status/revoking JTIs. Hash collisions only
// serialize unrelated tenants more than needed; never authorize another tenant.
import { sequelize } from './db.js';
import { assertTenantTransaction } from './tenantDbSafety.js';

const LOCK_NAMESPACE = 'sedeagro-pilot-tenant-status-v1';

function lockQuery(mode) {
  if (mode === 'shared') {
    return "SELECT pg_advisory_xact_lock_shared(hashtext(:namespace), hashtext(:tenantId))";
  }
  if (mode === 'exclusive') {
    return "SELECT pg_advisory_xact_lock(hashtext(:namespace), hashtext(:tenantId))";
  }
  throw new Error('Tenant lifecycle fence mode invalid.');
}

export async function lockTenantLifecycle(transaction, tenantId, mode) {
  assertTenantTransaction(transaction, tenantId);
  await sequelize.query(lockQuery(mode), {
    transaction,
    replacements: { namespace: LOCK_NAMESPACE, tenantId }
  });
}
