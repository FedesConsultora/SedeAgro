import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentSessionExpiry } from '../src/services/sessionExpiryScope.js';

const TENANT = 'e4de2fc5-8808-46bf-a41f-07f69eef2e7d';
const USER_A = '19d16e86-9ae5-466e-939b-6ac1c67fafc3';
const USER_B = '70be7d89-5e0e-4b75-a8f9-ab8c19cd9c70';
const OTHER_TENANT = '627c76a0-7a75-43d2-8714-31cc8f6e79cc';
const session = { authenticated: true, tenant: { id: TENANT }, user: { id: USER_A } };
const detail = { scope: `${TENANT}:${USER_A}`, epoch: 3 };

test('a 401 can revoke the exact authenticated identity and epoch', () => {
  assert.equal(isCurrentSessionExpiry(detail, session, 3), true);
  assert.equal(isCurrentSessionExpiry({ ...detail, epoch: 2 }, session, 3), false,
    'same account after re-login must not inherit old 401');
  assert.equal(isCurrentSessionExpiry({ ...detail, epoch: 4 }, session, 3), false);
});

test('delayed 401 from another user/tenant never invalidates the new cookie session', () => {
  assert.equal(isCurrentSessionExpiry(detail, {
    ...session, user: { id: USER_B }
  }, 3), false);
  assert.equal(isCurrentSessionExpiry(detail, {
    ...session, tenant: { id: OTHER_TENANT }
  }, 3), false);
  assert.equal(isCurrentSessionExpiry(detail, { ...session, authenticated: false }, 3), false);
});

test('legacy, malformed and anonymous events never cause global sign-out', () => {
  for (const candidate of [
    null, undefined, {}, { scope: detail.scope }, { epoch: 3 },
    { scope: detail.scope, epoch: 0 },
    { scope: detail.scope, epoch: '3' },
    { scope: detail.scope, epoch: Number.MAX_SAFE_INTEGER + 1 },
    { scope: null, epoch: 3 }, { scope: '', epoch: 3 },
    { ...detail, scope: `${OTHER_TENANT}:${USER_A}` }
  ]) {
    assert.equal(isCurrentSessionExpiry(candidate, session, 3), false);
  }
  assert.equal(isCurrentSessionExpiry(detail, session, 0), false);
});
