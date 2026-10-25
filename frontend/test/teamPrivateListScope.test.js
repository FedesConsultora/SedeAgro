import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { teamPrivateListScope, checkedTeamPrivateRows } from '../src/services/teamPrivateListScope.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const other = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const user = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const membership = '96df2c65-ae43-4dbf-9080-42bf218d6d49';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: user },
  membership: { id: membership, roleCode: 'tenant_admin' },
  entitlements: ['org', 'gis'] };

test('live lists use tenant, actor, membership, role and entitlements', () => {
  const scope = teamPrivateListScope(session, 'live');
  assert.ok(scope);
  assert.equal(teamPrivateListScope({ ...session, entitlements: ['gis', 'org', 'org'] },
    'live'), scope);
  for (const patch of [
    { tenant: { id: other } }, { user: { id: other } },
    { membership: { id: other, roleCode: 'tenant_admin' } },
    { membership: { id: membership, roleCode: 'scout' } },
    { entitlements: ['org', 'scouting'] }
  ]) assert.notEqual(teamPrivateListScope({ ...session, ...patch }, 'live'), scope);
  for (const patch of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: null }, { entitlements: ['gis'] }, { entitlements: null }
  ]) assert.equal(teamPrivateListScope({ ...session, ...patch }, 'live'), null);
  assert.equal(teamPrivateListScope(session, 'mock'), 'demo');
  assert.equal(teamPrivateListScope(session, 'offline'), null);
});

test('server tenant rows are accepted only for current tenant, malformed lists fail closed', () => {
  const members = [{ id: membership, tenant_id: tenant, role_code: 'scout' }];
  assert.equal(checkedTeamPrivateRows(members, tenant, 'miembros'), members);
  const minimal = [{ id: membership }];
  assert.equal(checkedTeamPrivateRows(minimal, tenant, 'equipos'), minimal);
  for (const rows of [
    undefined, null, {}, { data: [] }, [{ id: membership, tenant_id: other }],
    [null], [12], [{ id: 12 }], [[], members[0]]
  ]) assert.throws(() => checkedTeamPrivateRows(rows, tenant, 'miembros'),
    /inválida|otra empresa/i);
});

test('UI derives visible data by both principal and API, without old async response', () => {
  const source = readFileSync(new URL('../src/pages/TeamPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /teamPrivateListScope\(session, dataMode\)/);
  assert.match(source, /snapshot\?\.scope === scope && snapshot\?\.api === api/);
  assert.match(source, /scopeRef\.current === requestScope/);
  assert.match(source, /apiRef\.current === requestApi/);
  assert.match(source, /Promise\.allSettled\(\[requestApi\.members\(\), requestApi\.teams\(\)\]\)/);
  assert.match(source, /checkedTeamPrivateRows\(rows, requestTenant, label\)/);
  assert.match(source, /if \(current\(\)\) setSnapshot\(next\)/);
  assert.match(source, /dataMode === 'mock'/);
  assert.match(source, /dataMode !== 'mock' \|\| scope !== 'demo'/);
  assert.doesNotMatch(source, /setMembers\(rows\)/);
  assert.doesNotMatch(source, /setTeams\(rows\)/);
});

test('access failure for one collection does not display stale or fabricated rows', () => {
  const source = readFileSync(new URL('../src/pages/TeamPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /next\[name\] = \[\]/);
  assert.match(source, /next\.errors\[name\] = err\?\.message/);
  assert.match(source, /visible\?\.members \|\| \[\]/);
  assert.match(source, /visible\?\.teams \|\| \[\]/);
  assert.doesNotMatch(source, /mockData\.members/);
});
