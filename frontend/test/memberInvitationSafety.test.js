import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  memberInviteAuthority, prepareMemberInvitation, confirmMemberInvitation,
  checkedMemberInvitations, createMemberInviteGate, confirmMemberActivation,
  prepareMemberInviteRotation, confirmMemberInviteRotation
} from '../src/services/memberInvitationSafety.js';

const tid = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const userId = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const session = { authenticated: true, tenant: { id: tid },
  user: { id: userId }, membership: {
    id: '96df2c65-ae43-4dbf-9080-42bf218d6d49', roleCode: 'tenant_admin'
  }, entitlements: ['org', 'gis'] };

test('only live authorized tenant admin can prepare an invitation', () => {
  assert.ok(memberInviteAuthority(session, 'live'));
  for (const [patch, mode] of [
    [{ membership: { ...session.membership, roleCode: 'scout' } }, 'live'],
    [{ entitlements: ['gis'] }, 'live'],
    [{ authenticated: false }, 'live'],
    [{ tenant: { id: userId } }, 'mock']
  ]) assert.equal(memberInviteAuthority({ ...session, ...patch }, mode), null);
  const result = prepareMemberInvitation({ email: ' Scout@Example.COM ', roleCode: 'scout' }, session, 'live');
  assert.deepEqual(result.body, { email: 'scout@example.com', roleCode: 'scout' });
  for (const roleCode of ['tenant_admin', 'platform_admin', '*']) {
    assert.throws(() => prepareMemberInvitation({ email: 'test@example.com', roleCode }, session, 'live'),
      /rol.*permitido/);
  }
});

test('creation ACK must match exact tenant, email, role and one-time manual code', () => {
  const request = prepareMemberInvitation({ email: 'scout@example.com', roleCode: 'scout' }, session, 'live');
  const data = { id: userId, email: 'scout@example.com', roleCode: 'scout',
    status: 'pending', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
  const response = { data, delivery: { channel: 'manual', delivered: false,
    token: tid + '.' + 'a'.repeat(64) } };
  assert.equal(confirmMemberInvitation(response, request).secret, response.delivery.token);
  for (const broken of [
    { ...response, data: { ...data, email: 'other@example.com' } },
    { ...response, data: { ...data, roleCode: 'tenant_admin' } },
    { ...response, delivery: { ...response.delivery, delivered: true } },
    { ...response, delivery: { ...response.delivery, token: userId + '.' + 'a'.repeat(64) } },
    { ...response, data: { ...data, expiresAt: '2020-01-01T00:00:00.000Z' } }
  ]) assert.throws(() => confirmMemberInvitation(broken, request), /no confirmó/);
});

test('invitation lists are bounded and never return secrets', () => {
  const row = { id: userId, email: 'scout@example.com', roleCode: 'scout',
    expiresAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'pending' };
  assert.deepEqual(checkedMemberInvitations({ data: [row] }), [row]);
  assert.throws(() => checkedMemberInvitations({ data: [{ ...row, token: 'secret' }] }), /inválidas/);
  assert.throws(() => checkedMemberInvitations({ data: [{ ...row, roleCode: 'platform_admin' }] }), /inválidas/);
  assert.throws(() => checkedMemberInvitations({ data: {} }), /inválidas/);
});

test('synchronous gate prevents double submits and UI fences private secrets', () => {
  const gate = createMemberInviteGate();
  assert.equal(gate.acquire(), true);
  assert.equal(gate.acquire(), false);
  gate.release();
  assert.equal(gate.acquire(), true);
  const source = readFileSync(new URL('../src/components/MemberInvitationPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /secret\?\.scope === scope && secret\?\.api === api/);
  assert.match(source, /scopeRef\.current === requestScope/);
  assert.match(source, /apiRef\.current === requestApi/);
  assert.match(source, /confirmMemberInvitation\(response, prepared\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|location\.search/);
});

test('recipient success must be confirmed by the same tenant as pasted secret', () => {
  const secret = tid + '.' + 'a'.repeat(64);
  const receipt = { next: 'login', data: {
    id: userId, roleCode: 'scout', tenant: { id: tid, name: 'Farm' }
  } };
  assert.deepEqual(confirmMemberActivation(receipt, secret),
    { tenantName: 'Farm', role: 'scout' });
  assert.throws(() => confirmMemberActivation({
    ...receipt, data: { ...receipt.data, tenant: { id: userId, name: 'Other' } }
  }, secret), /no confirmó/);
  assert.throws(() => confirmMemberActivation({
    ...receipt, data: { ...receipt.data, roleCode: 'tenant_admin' }
  }, secret), /no confirmó/);
  const src = readFileSync(new URL('../src/pages/InviteAcceptancePage.jsx', import.meta.url), 'utf8');
  assert.match(src, /credentials: 'omit'/);
  assert.match(src, /confirmMemberActivation\(result, form\.token\.trim\(\)\)/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|location\.search|URLSearchParams/);
});


test('admin can request a pending-code replacement but cannot invent a delivered invite', () => {
  const now = Date.now();
  const row = {
    id: userId, email: 'scout@example.com', roleCode: 'scout',
    status: 'pending', updatedAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 2 * 86400000).toISOString()
  };
  const prepared = prepareMemberInviteRotation(row, session, 'live');
  assert.equal(prepared.id, userId);
  assert.equal(prepared.tenantId, tid);
  assert.equal(prepared.expectedUpdatedAt, row.updatedAt);
  const reply = { data: { ...row,
    updatedAt: new Date(now + 1000).toISOString(),
    expiresAt: new Date(now + 7 * 86400000).toISOString()
  }, delivery: { channel: 'manual', delivered: false,
    token: tid + '.' + 'b'.repeat(64) } };
  assert.equal(confirmMemberInviteRotation(reply, prepared).secret, reply.delivery.token);
  for (const fail of [
    { ...reply, data: { ...reply.data, id: tid } },
    { ...reply, data: { ...reply.data, updatedAt: row.updatedAt } },
    { ...reply, data: { ...reply.data, roleCode: 'contractor' } },
    { ...reply, delivery: { ...reply.delivery, delivered: true } },
    { ...reply, delivery: { ...reply.delivery, token: userId + '.' + 'b'.repeat(64) } }
  ]) assert.throws(() => confirmMemberInviteRotation(fail, prepared), /no confirmó/i);
  for (const invalid of [
    { ...row, status: 'accepted' },
    { ...row, roleCode: 'tenant_admin' },
    { ...row, expiresAt: new Date(now - 1000).toISOString() },
    { ...row, updatedAt: 'forged' },
    { ...row, id: 'not-uuid' }
  ]) assert.throws(() => prepareMemberInviteRotation(invalid, session, 'live'), /no puede renovarse/);
  assert.throws(() => prepareMemberInviteRotation(row, {
    ...session, membership: { ...session.membership, roleCode: 'scout' }
  }, 'live'), /Solo la administración/);
});

test('rotation is an explicit operator action: safe API, scopes, no secret persistence', () => {
  const panel = readFileSync(new URL('../src/components/MemberInvitationPanel.jsx', import.meta.url), 'utf8');
  const backend = readFileSync(new URL('../../backend/src/modules/auth/invitations.js', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
  assert.match(panel, /window\.confirm\('¿Invalidar el código anterior/);
  assert.match(panel, /gate\.current\.acquire\(\)/);
  assert.match(panel, /confirmMemberInviteRotation\(response, prepared\)/);
  assert.match(panel, /setSecret\(null\);\s*try \{/);
  assert.match(panel, /Reemitir código/);
  assert.match(api, /rotateMemberInvitation: \(id, expectedUpdatedAt\)/);
  assert.match(backend, /requireCapability\('members\.invite'\)/);
  assert.match(backend, /lock: transaction\.LOCK\.UPDATE/);
  assert.match(backend, /INVITATION_ROTATION_STALE/);
  assert.match(backend, /member_invitation\.rotated/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|location\.search/);
});
