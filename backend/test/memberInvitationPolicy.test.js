import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invitationTokenIdentity, newInvitationToken, hasMemberCapacity,
  isInvitableRole, normalizeInvitationEmail, INVITATION_TTL_MS
} from '../src/modules/auth/memberInvitationPolicy.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
test('invitation secret is unguessable bearer data and hash binds complete tenant+secret', () => {
  const a = newInvitationToken(tenantA);
  const b = newInvitationToken(tenantB);
  const a2 = newInvitationToken(tenantA);
  assert.match(a, /^11111111-1111-4111-8111-111111111111\.[a-f0-9]{64}$/);
  const identity = invitationTokenIdentity(a);
  assert.equal(identity.tenantId, tenantA);
  assert.match(identity.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(identity.tokenHash, invitationTokenIdentity(b).tokenHash);
  assert.notEqual(identity.tokenHash, invitationTokenIdentity(a2).tokenHash);
  assert.equal(invitationTokenIdentity(a.slice(0, -1)), null);
  assert.equal(invitationTokenIdentity(a + 'garbage'), null);
  assert.equal(invitationTokenIdentity({ token: a }), null);
  assert.equal(invitationTokenIdentity('not-a-uuid.' + 'a'.repeat(64)), null);
});
test('no platform/admin privileges can be granted through invitations', () => {
  for (const role of ['tenant_admin', 'platform_admin', 'platform_support', '*', '']) {
    assert.equal(isInvitableRole(role), false);
  }
  for (const role of ['scout', 'contractor', 'agronomic_coordinator', 'producer_viewer']) {
    assert.equal(isInvitableRole(role), true);
  }
});
test('seat budget accounts for active plus outstanding invitations', () => {
  assert.equal(hasMemberCapacity(1, 0, 8), true);
  assert.equal(hasMemberCapacity(3, 4, 8), true);
  assert.equal(hasMemberCapacity(3, 5, 8), false);
  assert.equal(hasMemberCapacity(-1, 1, 8), false);
  assert.equal(hasMemberCapacity(1, 0, Infinity), false);
  assert.equal(hasMemberCapacity(1, 0, '8'), false);
  assert.equal(INVITATION_TTL_MS, 604800000);
  assert.equal(normalizeInvitationEmail('  Scout@EXAMPLE.COM  '), 'scout@example.com');
});
