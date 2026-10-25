import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTenantChoices } from '../src/services/loginAttemptSafety.js';

const record = { tenantId: '9d941d8a-9a66-4c6d-8469-54c37596e3a9',
  tenantName: 'Empresa', tenantSlug: 'agro', roleCode: 'tenant_admin' };

test('existing slugs accepted by backend remain selectable', () => {
  for (const slug of ['-agro', 'agro-', '---', 'a'.repeat(90)]) {
    const rows = verifyTenantChoices({ requiresTenantSelection: true,
      memberships: [{ ...record, tenantSlug: slug }] });
    assert.equal(rows[0].tenantSlug, slug);
  }
  for (const slug of ['ab', 'a'.repeat(91), 'UPPER', 'agro/foo']) {
    assert.throws(() => verifyTenantChoices({ requiresTenantSelection: true,
      memberships: [{ ...record, tenantSlug: slug }] }), /empresa/i);
  }
});
