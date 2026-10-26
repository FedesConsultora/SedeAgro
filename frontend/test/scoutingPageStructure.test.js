import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/ScoutingPage.jsx', import.meta.url), 'utf8');
const [detailScope, pageScope] = page.split('export function ScoutingPage');

test('RunDetail never references parent-only deep-link props or collection state', () => {
  assert.ok(detailScope.includes('function RunDetail({ run, onChanged, onOpenSync })'));
  assert.doesNotMatch(detailScope, /\bfocusRunId\b/);
  assert.doesNotMatch(detailScope, /\bruns\.some\(/);
});

test('deep-link absence belongs to ScoutingPage and requires a successful list fetch', () => {
  assert.ok(pageScope.includes('isFocusedScoutingRunUnavailable(focusRunId, visibleRuns, visibleLoading, visibleError)'));
  assert.ok(pageScope.includes('setExpanded(current => ({ ...current, [focusRunId]: true }))'));
  assert.ok(pageScope.includes('setRuns(parseScoutingRuns(response, session.tenant.id))'));
});

test('the detail always validates the returned run ID and scopes controls to it', () => {
  assert.ok(detailScope.includes('parseScoutingRunDetail(response, run.id, session?.tenant?.id)'));
  assert.ok(detailScope.includes('scoutingRunCapabilities(details, session, dataMode)'));
  assert.ok(detailScope.includes('detailRequestSequence.current !== sequence'));
});

test('run list and expanded GPS detail are scoped to current tenant and actor', () => {
  assert.ok(pageScope.includes("scoutingPrivateViewScope(session, dataMode)"));
  assert.ok(pageScope.includes("setLoadedApi(api)"));
  assert.ok(pageScope.includes("visibleScoutingRuns(runs, loadedScope, loadedApi, scope, api)"));
  assert.ok(pageScope.includes("listScopeRef.current === scope && listApiRef.current === api"));
  assert.ok(pageScope.includes("<RunDetail key={scope + ':' + run.id}"));
});
