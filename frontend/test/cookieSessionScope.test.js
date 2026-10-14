import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionScope } from '../src/services/offlineSyncModel.js';

const tenant = '4f776e88-e1ad-43e6-9a3f-dfe597257997';
const user = '70da417a-8912-4c45-89ad-e99fdb1cb765';

test('offline queue scopes HttpOnly authenticated sessions without requiring readable JWT', () => {
  assert.equal(sessionScope({ authenticated: true, user: { id: user }, tenant: { id: tenant } }),
    `${tenant}:${user}`);
  assert.equal(sessionScope({ authenticated: false, user: { id: user }, tenant: { id: tenant } }), null);
  assert.equal(sessionScope({ user: { id: user }, tenant: { id: tenant } }), null);
  // Legacy unit-level Bearer client compatibility remains testable.
  assert.equal(sessionScope({ token: 'test-jwt', user: { id: user }, tenant: { id: tenant } }),
    `${tenant}:${user}`);
});
