import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  prepareCompanyRegistration, verifyRegisteredCompany, createCompanyRegistrationGate
} from '../src/services/companyRegistrationSafety.js';

const tenantId = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actorId = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const memberId = '96df2c65-ae43-4dbf-9080-42bf218d6d49';
const request = { organizationName: ' Agro Norte ', slug: 'agro-norte',
  fullName: ' Ana Productora ', email: '  Ana@Example.com  ',
  password: 'example-pass-1234' };
const canonical = { organizationName: 'Agro Norte', slug: 'agro-norte',
  fullName: 'Ana Productora', email: 'ana@example.com',
  password: 'example-pass-1234', planCode: 'starter' };
const reply = {
  user: { id: actorId, email: 'ana@example.com', fullName: 'Ana Productora' },
  tenant: { id: tenantId, slug: 'agro-norte', name: 'Agro Norte', status: 'active' },
  membership: { id: memberId, roleCode: 'tenant_admin', status: 'active' },
  entitlements: ['org', 'gis', 'campaigns', 'scouting']
};

test('registration prepares immutable values and only starter plan for first pilot', () => {
  assert.deepEqual(prepareCompanyRegistration(request), canonical);
  assert.equal(Object.isFrozen(prepareCompanyRegistration(request)), true);
});

test('bad names, slug, email and short password fail before any POST', () => {
  for (const changed of [
    { organizationName: ' ' }, { organizationName: 'x'.repeat(181) },
    { fullName: 'x' }, { fullName: 'x'.repeat(181) },
    { slug: '../farm' }, { slug: 'UPPERCASE' }, { slug: 'no' },
    { email: 'invalid' }, { email: '' }, { password: '' },
    { password: 'short' }, { password: null }
  ]) assert.throws(() => prepareCompanyRegistration({ ...request, ...changed }),
    /empresa|nombre|identificador|email|contraseña/i);
});

test('registration ACK must match company slug/name, actor email/name and admin membership', () => {
  assert.equal(verifyRegisteredCompany(reply, canonical), reply);
  for (const changed of [
    { user: { ...reply.user, id: 'invalid' } },
    { user: { ...reply.user, email: 'other@example.com' } },
    { user: { ...reply.user, fullName: 'Other' } },
    { tenant: { ...reply.tenant, id: 'invalid' } },
    { tenant: { ...reply.tenant, slug: 'different-farm' } },
    { tenant: { ...reply.tenant, name: 'Other farm' } },
    { membership: { ...reply.membership, id: 'invalid' } },
    { membership: { ...reply.membership, roleCode: 'scout' } },
    { membership: { ...reply.membership, status: 'invited' } },
    { entitlements: [null] }, { entitlements: 'not-array' },
    { token: 'unwanted-readable-token' }
  ]) assert.throws(() => verifyRegisteredCompany({ ...reply, ...changed }, canonical),
    /no confirmó/i);
  for (const invalid of [null, undefined, {}, { data: {} }, { tenant: {} }]) {
    assert.throws(() => verifyRegisteredCompany(invalid, canonical), /no confirmó/i);
  }
});

test('same-tick double click dispatches one tenant signup', async () => {
  const gate = createCompanyRegistrationGate();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const submit = async () => {
    const ticket = gate.acquire(request);
    if (!ticket) return 'blocked';
    calls++;
    await pending;
    verifyRegisteredCompany(reply, ticket.body);
    gate.finish(ticket, 'confirmed');
    return 'confirmed';
  };
  const first = submit();
  assert.equal(await submit(), 'blocked');
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'confirmed');
  assert.equal(gate.acquire(request), null);
  assert.equal(gate.isBlocked(), true);
});

test('known rejected response allows correction without forging success', () => {
  const gate = createCompanyRegistrationGate();
  const first = gate.acquire(request);
  assert.equal(gate.finish(first, 'rejected'), true);
  assert.equal(gate.isBlocked(), false);
  const next = gate.acquire({ ...request, slug: 'agro-norte-2' });
  assert.equal(next.body.slug, 'agro-norte-2');
  assert.equal(gate.finish(first, 'confirmed'), false);
  assert.equal(gate.isCurrent(next), true);
  assert.equal(gate.finish(next, 'confirmed'), true);
});

test('lost receipt stays blocked until user navigates away; no accidental retry', () => {
  const gate = createCompanyRegistrationGate();
  const ticket = gate.acquire(request);
  assert.equal(gate.isPending(), true);
  assert.equal(gate.finish(ticket, 'uncertain'), true);
  assert.equal(gate.isPending(), false);
  assert.equal(gate.isBlocked(), true);
  assert.equal(gate.acquire(request), null);
  gate.reset();
  assert.equal(gate.finish(ticket, 'confirmed'), false);
});

test('malformed form does not consume ticket', () => {
  const gate = createCompanyRegistrationGate();
  assert.throws(() => gate.acquire({ ...request, password: 'bad' }), /contraseña/);
  assert.equal(gate.isBlocked(), false);
  assert.ok(gate.acquire(request));
});

test('registration form uses one-shot ticket and validates reply, never stores secrets', () => {
  const jsx = readFileSync(new URL('../src/pages/RegisterPage.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /gate\.current\.acquire\(form\)/);
  assert.match(jsx, /body: JSON\.stringify\(ticket\.body\)/);
  assert.match(jsx, /verifyRegisteredCompany\(data, ticket\.body\)/);
  assert.match(jsx, /gate\.current\.finish\(ticket, 'confirmed'\)/);
  assert.match(jsx, /gate\.current\.finish\(ticket, 'uncertain'\)/);
  assert.match(jsx, /disabled=\{blocked\}/);
  assert.match(jsx, /login\(session\)/);
  assert.doesNotMatch(jsx, /localStorage|sessionStorage/);
});
