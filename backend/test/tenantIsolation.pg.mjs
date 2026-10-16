// Explicit integration gate: requires a disposable migrated PostgreSQL/PostGIS test database.
// This file is intentionally excluded from plain npm test; run npm run test:db with both URLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { isSafeRuntimeDbRole } from '../src/core/tenantDbSafety.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) {
  throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_APP_URL to a migrated disposable *_test database.');
}

const { Client } = pg;
const requiredScopedTables = [
  'producers', 'farms', 'fields', 'campaigns', 'campaign_fields',
  'scouting_runs', 'scouting_observations', 'work_orders', 'work_order_executions',
  'work_order_assignees', 'work_order_execution_exceptions', 'evidence_assets', 'rainfall_events',
  'irrigation_events', 'audit_events', 'teams', 'team_members',
  'machinery', 'agricultural_inputs', 'work_order_inputs',
  'work_order_machinery', 'satellite_layers', 'report_templates',
  'report_runs', 'sync_batches', 'sync_operations', 'notifications',
  'tenant_integrations', 'tenant_seat_usage',
  'tenant_modules', 'producer_access_grants', 'evidence_blobs'
];

test('postgres RLS isolates two tenants and blocks cross-tenant writes and FKs', async () => {
  const admin = new Client({ connectionString: adminUrl });
  const app = new Client({ connectionString: appUrl });
  let connectedAdmin = false;
  let connectedApp = false;
  const name = randomUUID().replaceAll('-', '').slice(0, 12);
  const aSlug = `rls-test-a-${name}`;
  const bSlug = `rls-test-b-${name}`;
  let a;
  let b;

  try {
    await admin.connect();
    connectedAdmin = true;
    const { rows: [{ db }] } = await admin.query('SELECT current_database() AS db');
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i,
      'Refusing to write fixtures into a database without a test identifier');

    const { rows: [plan] } = await admin.query("SELECT id FROM plans WHERE code = 'starter'");
    assert.ok(plan, 'Run migrations and global seeds before the RLS gate');

    const { rows: [tenantA] } = await admin.query(
      "INSERT INTO tenants (name, slug, plan_id, status) VALUES ($1, $2, $3, 'active') RETURNING id",
      ['RLS Test A', aSlug, plan.id]
    );
    a = tenantA.id;
    const { rows: [tenantB] } = await admin.query(
      "INSERT INTO tenants (name, slug, plan_id, status) VALUES ($1, $2, $3, 'active') RETURNING id",
      ['RLS Test B', bSlug, plan.id]
    );
    b = tenantB.id;

    const { rows: [farmA] } = await admin.query(
      "INSERT INTO farms (tenant_id, name) VALUES ($1, $2) RETURNING id",
      [a, `Farm A ${name}`]
    );
    const { rows: [farmB] } = await admin.query(
      "INSERT INTO farms (tenant_id, name) VALUES ($1, $2) RETURNING id",
      [b, `Farm B ${name}`]
    );

    const { rows: [secretB] } = await admin.query(
      "INSERT INTO tenant_integrations (tenant_id, provider, credentials) VALUES ($1, $2, $3::jsonb) RETURNING id",
      [b, 'rls-isolation-test', JSON.stringify({ privateToken: 'not-visible-to-A' })]
    );

    await app.connect();
    connectedApp = true;
    const { rows: [role] } = await app.query(`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
             pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
      WHERE r.rolname = current_user
    `);
    assert.ok(isSafeRuntimeDbRole(role), 'App URL must use non-owner role without RLS bypass privileges');

    const { rows: policies } = await admin.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    `, [requiredScopedTables]);
    assert.equal(policies.length, requiredScopedTables.length,
      'All tenant tables must exist before running isolation tests');
    for (const policy of policies) {
      assert.equal(policy.relrowsecurity, true, `RLS missing: ${policy.relname}`);
      assert.equal(policy.relforcerowsecurity, true, `FORCE RLS missing: ${policy.relname}`);
    }

    const noTenant = await app.query('SELECT id FROM farms WHERE id = $1', [farmA.id]);
    assert.equal(noTenant.rowCount, 0, 'Queries without tenant context must return no tenant data');

    await app.query('BEGIN');
    await app.query("SELECT set_config('app.current_tenant', $1, true)", [a]);
    assert.equal((await app.query('SELECT id FROM farms WHERE id = $1', [farmA.id])).rowCount, 1);
    assert.equal((await app.query('SELECT id FROM farms WHERE id = $1', [farmB.id])).rowCount, 0);
    assert.equal((await app.query('SELECT id FROM tenant_integrations WHERE id = $1', [secretB.id])).rowCount, 0,
      'Tenant A must not read tenant B integration secrets');

    await assert.rejects(
      app.query('INSERT INTO fields (tenant_id, farm_id, name) VALUES ($1, $2, $3)',
        [a, farmB.id, 'Forbidden cross-tenant FK']),
      (error) => error.code === '23503' || error.code === '42501'
    );
    await app.query('ROLLBACK');

    await app.query('BEGIN');
    await app.query("SELECT set_config('app.current_tenant', $1, true)", [b]);
    assert.equal((await app.query('SELECT id FROM farms WHERE id = $1', [farmA.id])).rowCount, 0);
    assert.equal((await app.query('SELECT id FROM farms WHERE id = $1', [farmB.id])).rowCount, 1);
    await app.query('COMMIT');

    const afterTransaction = await app.query('SELECT id FROM farms WHERE id = $1', [farmB.id]);
    assert.equal(afterTransaction.rowCount, 0,
      'Tenant setting must not leak outside its transaction');
  } finally {
    if (connectedApp) {
      await app.query('ROLLBACK').catch(() => {});
      await app.end().catch(() => {});
    }
    if (connectedAdmin) {
      if (a || b) {
        await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])',
          [[a, b].filter(Boolean)]).catch((error) => {
            process.stderr.write(`RLS fixture cleanup failed: ${error.message}\n`);
            throw error;
          });
      }
      await admin.end().catch(() => {});
    }
  }
});
