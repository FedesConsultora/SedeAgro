import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  memberInviteAuthority, prepareMemberInvitation, confirmMemberInvitation,
  checkedMemberInvitations, createMemberInviteGate
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
    expiresAt: new Date().toISOString(), status: 'pending' };
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
