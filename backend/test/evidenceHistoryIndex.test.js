import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../db/migrations/202610150001_evidence_history_read_indexes.js',import.meta.url),'utf8');

test('history indexes cover tenant keyset sort and observation-to-run authorization join', () => {
  assert.match(migration,/CREATE INDEX idx_evidence_scouting_tenant_history/);
  assert.match(migration,/evidence_assets \(tenant_id, created_at DESC, id DESC\)/);
  assert.match(migration,/INCLUDE \(scouting_observation_id\)/);
  assert.match(migration,/WHERE scouting_observation_id IS NOT NULL/);
  assert.match(migration,/CREATE INDEX idx_scouting_observations_tenant_run_id/);
  assert.match(migration,/scouting_observations \(tenant_id, scouting_run_id, id\)/);
});

test('indexes have reversible and scoped rollback, no table or policy changes', () => {
  assert.match(migration,/export async function up/);
  assert.match(migration,/export async function down/);
  assert.match(migration,/DROP INDEX IF EXISTS idx_scouting_observations_tenant_run_id/);
  assert.match(migration,/DROP INDEX IF EXISTS idx_evidence_scouting_tenant_history/);
  assert.doesNotMatch(migration,/ALTER TABLE|DROP TABLE|CREATE POLICY|DISABLE ROW LEVEL SECURITY|UPDATE evidence_assets/i);
});
