// Regression contract for the exact-head parallel PostgreSQL/Chromium gates.
// These structural checks do not replace their real GitHub disposable-DB runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/postgres-isolation.yml', import.meta.url), 'utf8');
function job(name) {
  const header = `  ${name}:\n`;
  const start = workflow.indexOf('\n' + header);
  assert.notEqual(start, -1, `mandatory job ${name} was removed`);
  const from = start + 1;
  const next = /^  [a-z][a-z0-9-]*:\s*$/gm;
  next.lastIndex = from + header.length;
  const match = next.exec(workflow);
  return workflow.slice(from, match ? match.index : undefined);
}

test('Chromium/PostGIS tests are a required parallel job with own budget', () => {
  const rls = job('tenant-rls');
  const browser = job('browser-postgis');
  assert.match(workflow, /on:\n\s+pull_request:\n\s+push:\n\s+branches: \[main\]/);
  assert.match(rls, /timeout-minutes: 20/);
  assert.match(browser, /timeout-minutes: 35/);
  assert.doesNotMatch(browser, /continue-on-error:\s*true/);
  assert.doesNotMatch(browser, /if:\s*false/);
  assert.doesNotMatch(browser, /needs:\s*\[?tenant-rls/);
  assert.doesNotMatch(rls, /Run real Chromium cookie and session acceptance/);
  assert.doesNotMatch(rls, /acceptance-browser-cookie\.mjs/);
  assert.match(rls, /Test tenant RLS, secrets and cross-tenant FK/);
  assert.match(rls, /Rehearse disposable PostGIS backup, restore and restored-db RLS/);
  assert.match(rls, /Profile review queue filters under real runtime FORCE RLS/);
});

test('browser job uses pinned isolated disposable PostGIS and exact HEAD nonowner role', () => {
  const rls = job('tenant-rls'), browser = job('browser-postgis');
  const pinned = /postgis\/postgis:16-3\.4@sha256:[0-9a-f]{64}/;
  assert.match(rls, pinned);
  assert.match(browser, pinned);
  assert.equal(rls.match(pinned)?.[0], browser.match(pinned)?.[0]);
  for (const required of [
    'POSTGRES_DB: sedeagro_test',
    'POSTGRES_USER: sedeagro_owner',
    'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
    'EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
    'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
    'Confirm pinned PostGIS test service is actually linux/amd64',
    'Prove real untouched PostGIS bootstrap footprint before migrations',
    'Migrate disposable PostGIS database',
    'Prove real migrated PostGIS cannot use first-install bypass',
    'Provision least-privilege runtime role',
    'scripts/provision-runtime-role.sql',
    'TEST_DATABASE_APP_URL: postgres://sedeagro_app:'
  ]) {
    assert.ok(browser.includes(required), `missing isolated browser PostGIS safeguard: ${required}`);
  }
  assert.match(browser, /NODE_ENV: test/);
  assert.match(browser, /SEED_MODE: ci/);
  assert.doesNotMatch(browser, /(?:deploy-prod|docker-compose\.prod|production_?db)/i);
});

test('all previous live Chromium cases and two 12-cycle focus passes remain mandatory', () => {
  const browser = job('browser-postgis');
  assert.match(browser, /npm ci/);
  assert.match(browser, /npm install --no-save --package-lock=false playwright@1\.58\.2/);
  assert.match(browser, /npx playwright install chromium --with-deps/);
  assert.match(browser, /for pass in 1 2; do/);
  assert.match(browser, /SEDEAGRO_FOCUS_STRESS_CYCLES=12 node scripts\/acceptance-browser-cookie\.mjs/);
  assert.match(browser, /node scripts\/acceptance-browser-evidence-history\.mjs/);
  assert.match(browser, /node scripts\/acceptance-browser-review-inbox\.mjs/);
  assert.match(browser, /SEDEAGRO_HTTP_LOAD_PROBE: I_ACCEPT_ONLY_GITHUB_DISPOSABLE_TEST_DATABASE/);
  for (const name of [
    'Run real Chromium cookie and session acceptance against PostgreSQL',
    'Run real Chromium evidence pagination, offline and revoked session acceptance',
    'Run real Chromium coordination inbox pagination, recovery and tenant isolation'
  ]) assert.equal(workflow.split(name).length - 1, 1, `duplicate or missing acceptance: ${name}`);
});
