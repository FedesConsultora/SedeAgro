import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TEAM_SCOPES, liveTeamAuthority, eligibleTeamMembers,
  prepareLiveTeamCreation, confirmLiveTeamCreation,
  prepareLiveTeamMember, confirmLiveTeamMember
} from '../src/services/teamOperationsSafety.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const foreign = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const otherUser = '83b2579a-253e-4141-acf9-05d19c3d4150';
const teamId = 'dce86e46-48a7-4630-a66d-36c0a4b8873f';
const membershipId = '96df2c65-ae43-4dbf-9080-42bf218d6d49';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: membershipId, roleCode: 'tenant_admin' }, entitlements: ['org'] };
const team = { id: teamId, tenant_id: tenant, name: 'Monitoreo', TeamMembers: [] };
const member = { id: membershipId, tenant_id: tenant, user_id: otherUser,
  role_code: 'scout', status: 'active',
  User: { id: otherUser, status: 'active', full_name: 'Operador', email: 'op@example.test' } };

test('live team mutation available to organization administrators/coordinators only', () => {
  assert.ok(liveTeamAuthority(session, 'live'));
  assert.ok(liveTeamAuthority({ ...session,
    membership: { ...session.membership, roleCode: 'agronomic_coordinator' } }, 'live'));
  for (const roleCode of ['scout', 'contractor', 'producer_viewer', 'unknown']) {
    assert.equal(liveTeamAuthority({ ...session,
      membership: { ...session.membership, roleCode } }, 'live'), null);
  }
  assert.equal(liveTeamAuthority(session, 'mock'), null);
  assert.equal(liveTeamAuthority({ ...session, authenticated: false }, 'live'), null);
  assert.equal(liveTeamAuthority({ ...session, entitlements: [] }, 'live'), null);
  assert.equal(liveTeamAuthority({ ...session, membership: null }, 'live'), null);
});

test('team creation accepts only valid normalized names and declared scopes', () => {
  const authority = liveTeamAuthority(session, 'live');
  assert.deepEqual(prepareLiveTeamCreation({
    name: '   Equipo  Norte  ', scope: 'field_ops'
  }, authority), { name: 'Equipo Norte', scope: 'field_ops' });
  assert.equal(TEAM_SCOPES.length, 5);
  for (const value of [
    { name: 'A', scope: 'field_ops' }, { name: 'Equipo', scope: 'elevated' },
    { name: 'Equipo\u0000filtrado', scope: 'field_ops' },
    { name: 'X'.repeat(161), scope: 'field_ops' }
  ]) assert.throws(() => prepareLiveTeamCreation(value, authority), /inválido|válido/i);
  assert.throws(() => prepareLiveTeamCreation({ name: 'Equipo', scope: 'field_ops' }, null), /permisos/i);
});

test('creation only considers same-tenant, same-content server receipt as confirmed', () => {
  const request = { name: 'Equipo Norte', scope: 'field_ops' };
  const success = { data: { id: teamId, tenant_id: tenant, ...request, farm_id: null, notes: null } };
  assert.equal(confirmLiveTeamCreation(success, request, tenant), success.data);
  assert.equal(confirmLiveTeamCreation({ ...success, replayed: true }, request, tenant).id, teamId);
  for (const payload of [
    null, { data: null }, { data: { ...success.data, id: 'fake' } },
    { data: { ...success.data, tenant_id: foreign } },
    { data: { ...success.data, name: 'Otro equipo' } },
    { data: { ...success.data, farm_id: foreign } },
    { ...success, replayed: 'true' }
  ]) assert.throws(() => confirmLiveTeamCreation(payload, request, tenant), /servidor/i);
});

test('roster choices exclude blocked, disabled, foreign, already-added users', () => {
  const blocked = { ...member, user_id: actor, status: 'blocked',
    User: { id: actor, status: 'active' } };
  const globalBlocked = { ...member, user_id: actor, User: { id: actor, status: 'blocked' } };
  const foreignRow = { ...member, user_id: actor, User: { id: foreign, status: 'active' } };
  assert.deepEqual(eligibleTeamMembers([member, blocked, globalBlocked, foreignRow], team),
    [member]);
  assert.deepEqual(eligibleTeamMembers([member], {
    ...team, TeamMembers: [{ user_id: otherUser }]
  }), []);
  assert.deepEqual(eligibleTeamMembers([member], null), []);
});

test('member creation blocks stale team ID, duplicated roster, no membership or unconfirmed ACK', () => {
  const authority = liveTeamAuthority(session, 'live');
  const input = { teamId, userId: otherUser, roleLabel: ' Monitoreo  de campo ' };
  const expected = {
    teamId, body: { user_id: otherUser, role_label: 'Monitoreo de campo' }
  };
  assert.deepEqual(prepareLiveTeamMember(input, [team], [member], authority), expected);
  for (const overrides of [
    { teamId: foreign }, { userId: actor }, { roleLabel: '\u202Einvisible' },
    { roleLabel: '' }
  ]) assert.throws(() => prepareLiveTeamMember({
    ...input, ...overrides
  }, [team], [member], authority), /elegí|válida/i);
  assert.throws(() => prepareLiveTeamMember(input, [team], [member], null), /permisos/i);
  const receipt = { data: { id: foreign, tenant_id: tenant, team_id: teamId,
    user_id: otherUser, role_label: expected.body.role_label } };
  assert.deepEqual(confirmLiveTeamMember(receipt, expected, tenant), receipt.data);
  for (const altered of [
    { ...receipt.data, id: 'not-uuid' },
    { ...receipt.data, tenant_id: foreign },
    { ...receipt.data, team_id: foreign },
    { ...receipt.data, user_id: actor },
    { ...receipt.data, role_label: 'Otro rol' }
  ]) assert.throws(() => confirmLiveTeamMember({ data: altered }, expected, tenant), /servidor/i);
});

test('live TeamPage connects operation panel only after private lists and gates stale responses', () => {
  const page = readFileSync(new URL('../src/pages/TeamPage.jsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/TeamOperationsPanel.jsx', import.meta.url), 'utf8');
  assert.match(page, /!errors\.members && !errors\.teams && <TeamOperationsPanel/);
  assert.match(page, /teams=\{teams\} members=\{members\}/);
  assert.match(panel, /liveTeamAuthority\(session, dataMode\)/);
  assert.match(panel, /pending\.current = ticket/);
  assert.match(panel, /scopeRef\.current === ticket\.authority/);
  assert.match(panel, /apiRef\.current === ticket\.api/);
  assert.match(panel, /confirmLiveTeamCreation\(response, expected, tenant\)/);
  assert.match(panel, /confirmLiveTeamMember\(response, expected, tenant\)/);
  assert.match(panel, /onUpdated\(\)/);
  assert.match(panel, /No quedó confirmada la operación/);
});

test('live operator can refresh scoped roster after invite acceptance without a second invite POST', () => {
  const page = readFileSync(new URL('../src/pages/TeamPage.jsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/MemberInvitationPanel.jsx', import.meta.url), 'utf8');
  const browser = readFileSync(new URL('../../scripts/acceptance-browser-cookie.mjs', import.meta.url), 'utf8');
  assert.match(page, /dataMode === 'live' && scope && <button[\s\S]*?Actualizar equipo/);
  assert.match(page, /onClick=\{\(\) => setRevision\(value => value \+ 1\)\}/);
  assert.match(page, /disabled=\{loading \|\| Boolean\(changing\)\}/);
  assert.match(page, /<MemberInvitationPanel[\s\S]*refreshKey=\{revision\}/);
  assert.match(panel, /\[scope, api, revision, refreshKey\]/);
  assert.match(page, /checkedTeamPrivateRows\(rows, requestTenant, label\)/);
  assert.match(browser, /const inviteContext = await browser\.newContext\(\)/);
  assert.match(browser, /getByRole\('button', \{ name: 'Actualizar equipo' \}\)\.click\(\)/);
  assert.match(browser, /getByRole\('button', \{ name: 'Agregar integrante' \}\)\.click\(\)/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|location\.search/);
});
