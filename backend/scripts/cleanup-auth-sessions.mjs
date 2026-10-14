// Explicit, bounded maintenance task. Never scheduled by the web process.
// Uses the schema-owner DB credentials, not the RLS-bound application role.
import { Sequelize, QueryTypes } from 'sequelize';

const dryRun = process.argv.length === 2 || process.argv[2] === '--dry-run';
const apply = process.argv.length === 3 && process.argv[2] === '--apply';
if (!dryRun && !apply) throw new Error('Use --dry-run or --apply.');
if (apply && process.env.CONFIRM_AUTH_SESSION_CLEANUP !== 'DELETE_EXPIRED_SESSIONS') {
  throw new Error('Set CONFIRM_AUTH_SESSION_CLEANUP=DELETE_EXPIRED_SESSIONS to authorize deletion.');
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required (DB schema owner only).');
const db = new Sequelize(url, { dialect: 'postgres', logging: false });
try {
  const [role] = await db.query(`
    SELECT current_user AS actor, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c WHERE c.oid = 'public.auth_sessions'::regclass
  `, { type: QueryTypes.SELECT });
  if (!role || role.actor !== role.owner) {
    throw new Error('Session cleanup requires table-owner credentials, never the application role.');
  }
  const cutoff = new Date(Date.now() - 30 * 86400_000);
  const [counts] = await db.query(`
    SELECT count(*)::integer AS eligible FROM auth_sessions
    WHERE expires_at < :cutoff OR (revoked_at IS NOT NULL AND revoked_at < :cutoff)
  `, { replacements: { cutoff }, type: QueryTypes.SELECT });
  if (dryRun) {
    console.log(JSON.stringify({ action: 'dry-run', eligible: counts.eligible,
      retentionDays: 30, maxRowsPerApply: 500 }));
  } else {
    const affected = await db.transaction(async (transaction) => db.query(`
      WITH doomed AS (
        SELECT id FROM auth_sessions
        WHERE expires_at < :cutoff OR (revoked_at IS NOT NULL AND revoked_at < :cutoff)
        ORDER BY expires_at ASC, id ASC
        FOR UPDATE SKIP LOCKED LIMIT 500
      )
      DELETE FROM auth_sessions a USING doomed WHERE a.id = doomed.id
      RETURNING a.id
    `, {
      replacements: { cutoff }, type: QueryTypes.DELETE, transaction
    }));
    // PostgreSQL returns row count as the second result for DELETE.
    const removed = Array.isArray(affected) ? affected[1] : affected;
    console.log(JSON.stringify({ action: 'applied', removed,
      retentionDays: 30, maxRowsPerApply: 500 }));
  }
} finally {
  await db.close();
}
