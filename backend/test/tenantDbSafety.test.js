import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTenantTransaction, isSafeRuntimeDbRole, SET_TENANT_SQL } from '../src/core/tenantDbSafety.js';

const tenantId = 'd35df972-0015-4566-98d8-f62bc88a44ad';

test('tenant context requires a live transaction and validated UUID', () => {
  assert.doesNotThrow(() => assertTenantTransaction({ finished: false }, tenantId));
  assert.throws(() => assertTenantTransaction(undefined, tenantId), /active database transaction/);
  assert.throws(() => assertTenantTransaction({ finished: 'commit' }, tenantId), /active database transaction/);
  for (const value of [undefined, '', 'another-tenant', 'abc', '0000; DROP TABLE users']) {
    assert.throws(() => assertTenantTransaction({ finished: false }, value), /valid UUID/);
  }
  assert.equal(SET_TENANT_SQL, "SELECT set_config('app.current_tenant', :tenantId, true) AS tenant_id");
});

test('production runtime role cannot own database or bypass RLS', () => {
  const base = {
    rolname: 'sedeagro_app', db_owner: 'sedeagro',
    rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false
  };
  assert.equal(isSafeRuntimeDbRole(base), true);
  for (const key of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb']) {
    assert.equal(isSafeRuntimeDbRole({ ...base, [key]: true }), false, key);
  }
  assert.equal(isSafeRuntimeDbRole({ ...base, db_owner: 'sedeagro_app' }), false);
  assert.equal(isSafeRuntimeDbRole({ ...base, rolbypassrls: undefined }), false);
  assert.equal(isSafeRuntimeDbRole(undefined), false);
});
