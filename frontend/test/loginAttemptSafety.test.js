import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createLoginAttemptGate, verifyTenantChoices, verifyLoginSession
} from '../src/services/loginAttemptSafety.js';

const tenantA = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const tenantB = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const userId = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const memberId = '96df2c65-ae43-4dbf-9080-42bf218d6d49';
const email = 'operador@example.com';
const identity = { email: '  Operador@Example.COM ', password: 'test-password-not-a-real-secret' };
const members = [
  { tenantId: tenantA, tenantSlug: 'campo-norte', tenantName: 'Campo Norte', roleCode: 'tenant_admin' },
  { tenantId: tenantB, tenantSlug: 'campo-sur', tenantName: 'Campo Sur', roleCode: 'scout' }
];
const challenge = { requiresTenantSelection: true, memberships: members };
const session = { user: { id: userId, email },
  tenant: { id: tenantA, slug: 'campo-norte' },
  membership: { id: memberId, roleCode: 'tenant_admin' },
  entitlements: ['gis', 'campaigns', 'scouting'] };

test('validated tenant options are bounded, unique and contain exact identities', () => {
  const output = verifyTenantChoices(challenge);
  assert.equal(output.length, 2);
  assert.equal(output[0].tenantId, tenantA);
  assert.equal(Object.isFrozen(output[0]), true);
  for (const invalid of [
    null, {}, { requiresTenantSelection: false, memberships: members },
    { requiresTenantSelection: true, memberships: [] },
    { requiresTenantSelection: true, memberships: Array(101).fill(members[0]) },
    { requiresTenantSelection: true, memberships: [members[0], members[0]] },
    { requiresTenantSelection: true, memberships: [{ ...members[0], tenantId: 'invalid' }] },
    { requiresTenantSelection: true, memberships: [{ ...members[0], tenantSlug: '../tenant' }] },
    { requiresTenantSelection: true, memberships: [{ ...members[0], tenantName: ' ' }] },
    { requiresTenantSelection: true, memberships: [{ ...members[0], roleCode: '' }] }
  ]) assert.throws(() => verifyTenantChoices(invalid), /empresas/i);
});

test('session ACK binds authenticated identity and selected tenant slug and role', () => {
  assert.equal(verifyLoginSession(session, email), session);
  assert.equal(verifyLoginSession(session, email, members[0]), session);
  for (const edited of [
    { user: { ...session.user, id: 'not-uuid' } },
    { user: { ...session.user, email: 'other@example.com' } },
    { tenant: { ...session.tenant, id: tenantB } },
    { membership: { ...session.membership, id: 'bad' } },
    { membership: { ...session.membership, roleCode: 'scout' } },
    { entitlements: null }, { entitlements: ['gis', null] },
    { requiresTenantSelection: true }
  ]) assert.throws(() => verifyLoginSession({ ...session, ...edited }, email, members[0]),
    /identidad|empresa/i);
  assert.throws(() => verifyLoginSession(session, email, members[1]), /identidad|empresa/i);
  assert.throws(() => verifyLoginSession({ ...session, tenant: {
    ...session.tenant, slug: 'campo-sur'
  } }, email, members[0]), /identidad|empresa/i);
});

test('double click before React update dispatches exactly one login request', async () => {
  const gate = createLoginAttemptGate();
  let release;
  const network = new Promise(resolve => { release = resolve; });
  let calls = 0;
  async function submit() {
    const ticket = gate.begin(identity);
    if (!ticket) return 'ignored';
    calls++;
    await network;
    return gate.complete(ticket, session)?.kind;
  }
  const first = submit();
  assert.equal(await submit(), 'ignored');
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'session');
  assert.equal(gate.begin(identity), null, 'confirmed session cannot dispatch again');
});

test('multiempresa flow pins original credentials and only permits offered tenant slug', () => {
  const gate = createLoginAttemptGate();
  const initial = gate.begin(identity);
  assert.equal(initial.body.email, email);
  assert.equal(Object.isFrozen(initial.body), true);
  assert.equal(gate.choose('campo-norte'), null, 'select unavailable during initial request');
  const result = gate.complete(initial, challenge);
  assert.equal(result.kind, 'choices');
  assert.equal(gate.begin(identity), null, 'credential form cannot restart while choosing company');
  assert.equal(gate.choose('not-in-list'), null);
  const selection = gate.choose('campo-norte');
  assert.ok(selection);
  assert.equal(selection.body.tenantSlug, members[0].tenantSlug);
  assert.equal(selection.body.email, email);
  assert.equal(selection.body.password, initial.body.password);
  assert.equal(gate.choose('campo-sur'), null, 'second simultaneous challenge is blocked');
  assert.equal(gate.complete(selection, session)?.kind, 'session');
  assert.equal(gate.choose('campo-sur'), null);
});

test('wrong tenant or malformed challenge cannot authenticate and is retryable safely', () => {
  const gate = createLoginAttemptGate();
  const first = gate.begin(identity);
  gate.complete(first, challenge);
  const selected = gate.choose('campo-sur');
  assert.throws(() => gate.complete(selected, session), /identidad|empresa/i);
  assert.equal(gate.fail(selected), true);
  assert.equal(gate.phase(), 'choices');
  const next = gate.choose('campo-norte');
  assert.ok(next);
  assert.equal(gate.complete(next, session)?.kind, 'session');
  assert.equal(gate.phase(), 'confirmed');
});

test('rejected first attempt resets and a prior result cannot change new login', () => {
  const gate = createLoginAttemptGate();
  const first = gate.begin(identity);
  assert.equal(gate.fail(first), true);
  const next = gate.begin({ ...identity, email: 'new@example.com' });
  assert.equal(gate.complete(first, session), null);
  assert.equal(gate.isCurrent(next), true);
  gate.reset();
  assert.equal(gate.complete(next, challenge), null);
  assert.equal(gate.phase(), 'idle');
  assert.equal(gate.choose(members[0].tenantSlug), null);
});

test('backend sends invalid repeated selection as error rather than completing', () => {
  const gate = createLoginAttemptGate();
  const ticket = gate.begin(identity);
  gate.complete(ticket, challenge);
  const selected = gate.choose('campo-norte');
  assert.throws(() => gate.complete(selected, challenge), /selección de empresa/i);
  assert.equal(gate.fail(selected), true);
  assert.equal(gate.phase(), 'choices');
});

test('login component wires one-shot gate and disables edits and switches while pending', () => {
  const source = readFileSync(new URL('../src/pages/LoginPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /createLoginAttemptGate\(\)/);
  assert.match(source, /gate\.current\.begin\(form\)/);
  assert.match(source, /gate\.current\.choose\(slug\)/);
  assert.match(source, /gate\.current\.isCurrent\(ticket\)/);
  assert.match(source, /gate\.current\.complete\(ticket, data\)/);
  assert.match(source, /body: JSON\.stringify\(ticket\.body\)/);
  assert.match(source, /disabled=\{locked\}/);
  assert.match(source, /login\(next\.session\)/);
  assert.match(source, /gate\.current\.reset\(\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});
