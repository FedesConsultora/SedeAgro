import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isManageableMembership, hasSeatForActivation, membershipStatusReceipt
} from '../src/modules/auth/memberLifecyclePolicy.js';

const tid = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const member = { id: 'm', tenant_id: tid, user_id: '33333333-3333-4333-8333-333333333333',
  role_code: 'scout', status: 'active' };
test('member manager cannot target itself, foreign tenant, admins or pending members', () => {
  assert.equal(isManageableMembership(member, actor, tid), true);
  assert.equal(isManageableMembership({ ...member, status: 'blocked' }, actor, tid), true);
  for (const role of ['tenant_admin','platform_admin','platform_support','unknown']) {
    assert.equal(isManageableMembership({ ...member, role_code: role }, actor, tid), false);
  }
  assert.equal(isManageableMembership({ ...member, user_id: actor }, actor, tid), false);
  assert.equal(isManageableMembership({ ...member, tenant_id: actor }, actor, tid), false);
  assert.equal(isManageableMembership({ ...member, status: 'pending' }, actor, tid), false);
});
test('reactivation seat budget counts active and pending invitations', () => {
  assert.equal(hasSeatForActivation({ active: 1, pending: 0, maxUsers: 2 }), true);
  assert.equal(hasSeatForActivation({ active: 1, pending: 1, maxUsers: 2 }), false);
  assert.equal(hasSeatForActivation({ active: 2, pending: 0, maxUsers: 2 }), false);
  assert.equal(hasSeatForActivation({ active: -1, pending: 1, maxUsers: 4 }), false);
  assert.equal(hasSeatForActivation({ active: 1, pending: 0, maxUsers: '4' }), false);
});
test('status receipt contains no passwords, token or secret identifiers', () => {
  assert.deepEqual(membershipStatusReceipt({ ...member, password_hash: 'secret' }, true), {
    id: 'm', tenant_id: tid, user_id: member.user_id, role_code: 'scout',
    status: 'active', changed: true
  });
});
