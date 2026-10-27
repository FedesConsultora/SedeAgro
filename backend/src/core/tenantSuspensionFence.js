// Stable import surface for transaction-scoped tenant lifecycle fencing.
// The SQL implementation lives in the trusted core/db.js helper so the
// repository raw-SQL audit remains strict; no RLS bypass is introduced.
export { lockTenantLifecycle } from './db.js';
