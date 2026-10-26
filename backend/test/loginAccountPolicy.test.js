import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canIssueLoginForGlobalAccount } from '../src/modules/auth/loginAccountPolicy.js';

test('global account eligibility is active-only and independent from tenant membership', () => {
  assert.equal(canIssueLoginForGlobalAccount({ status: 'active' }), true);
  for (const user of [null, undefined, {}, {status:'blocked'},
    {status:'deleted'}, {status:'pending'}, {status:'ACTIVE'},
    {status:''}, {status:null}]) {
    assert.equal(canIssueLoginForGlobalAccount(user), false);
  }
});

test('public tenant selection requires global status after password and before membership enumeration', () => {
  const src = readFileSync(new URL('../src/modules/auth/router.js', import.meta.url), 'utf8');
  const login = src.slice(src.indexOf("authPublicRouter.post('/login'"),
    src.indexOf("authScopedRouter.post('/logout'"));
  const checked = login.indexOf('canIssueLoginForGlobalAccount(user)');
  const listing = login.indexOf('const memberships = await Membership.findAll');
  const issued = login.indexOf('issueTenantSession(user, selectedMembership, transaction)');
  assert.ok(checked > 0 && listing > checked && issued > listing,
    'global user status must be enforced before public tenant choices and JWT session');
  assert.match(login,/!canIssueLoginForGlobalAccount\(user\)/);
  assert.match(login,/new HttpError\(401, 'Email o contraseña incorrectos\.'/);
  assert.match(login,/requiresTenantSelection: true/);
});

test('session reservation rechecks status under a row-level lock after password verification', () => {
  const src = readFileSync(new URL('../src/modules/auth/sessionPolicy.js', import.meta.url), 'utf8');
  assert.match(src,/User\.findByPk\(userId,/);
  assert.match(src,/lock: transaction\.LOCK\.UPDATE/);
  assert.match(src,/attributes: \['id', 'status'\]/);
  assert.match(src,/!canIssueLoginForGlobalAccount\(owner\)/);
  assert.ok(src.indexOf('!canIssueLoginForGlobalAccount(owner)') <
    src.indexOf('const active = await AuthSession.findAll'),
    'must fail before evicting any existing session or reserving a new one');
});
