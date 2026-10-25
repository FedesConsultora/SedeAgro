import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  farmCreateScope, prepareFarmCreate, verifyCreatedFarm, createFarmSubmitGate
} from '../src/services/farmCreateSafety.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const member = '96df2c65-ae43-4dbf-9080-42bf218d6d49';
const producer = 'b5f05b5f-1132-4342-b385-c004443f2cd9';
const other = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const farmId = '4b73e9e8-9375-41db-a574-7bbb38381704';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: member, roleCode: 'agronomic_coordinator' },
  entitlements: ['gis', 'campaigns'] };
const producers = [{ id: producer, name: 'Productor Uno' }];
const form = { name: ' La Esperanza ', producer_id: producer, locality: ' Pergamino ',
  province: ' Buenos Aires ', country: 'Argentina', notes: ' Norte ' };
const body = { name: 'La Esperanza', producer_id: producer,
  locality: 'Pergamino', province: 'Buenos Aires', country: 'Argentina', notes: 'Norte' };
const row = { id: farmId, tenant_id: tenant, ...body };
const receipt = { data: row, replayed: false };

test('scope binds session identity, role and entitlements before rendering private producers', () => {
  const scope = farmCreateScope(session, 'live');
  assert.ok(scope);
  assert.equal(farmCreateScope({ ...session, entitlements: ['campaigns', 'gis', 'gis'] }, 'live'), scope);
  for (const change of [
    { tenant: { id: other } }, { user: { id: other } },
    { membership: { id: other, roleCode: 'agronomic_coordinator' } },
    { membership: { id: member, roleCode: 'tenant_admin' } }, { entitlements: ['gis'] }
  ]) assert.notEqual(farmCreateScope({ ...session, ...change }, 'live'), scope);
  for (const change of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: { id: member, roleCode: 'scout' } },
    { entitlements: ['scouting'] }, { entitlements: null }
  ]) assert.equal(farmCreateScope({ ...session, ...change }, 'live'), null);
  assert.equal(farmCreateScope(session, 'mock'), null);
});

test('farm payload is normalized and optional empty metadata is omitted', () => {
  assert.deepEqual(prepareFarmCreate(form, producers, tenant), body);
  assert.equal(Object.isFrozen(prepareFarmCreate(form, producers, tenant)), true);
  assert.deepEqual(prepareFarmCreate({
    ...form, producer_id: '', locality: '', province: '', notes: '', country: ''
  }, [], tenant), { name: 'La Esperanza', producer_id: null, country: 'Argentina' });
});

test('unknown/foreign producer and unavailable catalog cannot be sent as live IDs', () => {
  for (const change of [
    { producer_id: other }, { producer_id: 'invalid' }
  ]) assert.throws(() => prepareFarmCreate({ ...form, ...change }, producers, tenant),
    /productor/i);
  assert.throws(() => prepareFarmCreate(form, [{ id: producer, tenant_id: other }], tenant),
    /productor/i);
  assert.throws(() => prepareFarmCreate(form, null, tenant), /verificar/i);
  assert.throws(() => prepareFarmCreate(form, producers, 'invalid'), /verificar/i);
});

test('frontend validates same contract for names and geography as backend', () => {
  for (const change of [
    { name: 'a' }, { name: 'x'.repeat(181) },
    { locality: 'x'.repeat(141) }, { province: 'x'.repeat(141) },
    { country: 'x'.repeat(81) }, { notes: 42 }
  ]) assert.throws(() => prepareFarmCreate({ ...form, ...change }, producers, tenant),
    /campo/i);
});

test('confirmed or replayed ACK must match exact tenant, producer and geography', () => {
  assert.equal(verifyCreatedFarm(receipt, body, tenant), row);
  assert.equal(verifyCreatedFarm({ ...receipt, replayed: true }, body, tenant), row);
  for (const patch of [
    { id: 'bad' }, { tenant_id: other }, { name: 'Otro' },
    { producer_id: other }, { producer_id: null }, { locality: 'Otra localidad' },
    { province: null }, { notes: 'Texto cambiado' }, { country: null }
  ]) assert.throws(() => verifyCreatedFarm({ data: { ...row, ...patch }, replayed: false },
    body, tenant), /no confirmó/i);
  for (const invalid of [
    null, {}, { data: row }, { data: row, replayed: 'true' }, { data: {} }
  ]) assert.throws(() => verifyCreatedFarm(invalid, body, tenant), /no confirmó/i);
});

test('optional empty response values and tenant-safe replay keep same identity', () => {
  const request = { name: 'Lote Base', producer_id: null, country: 'Argentina' };
  const stored = { id: farmId, tenant_id: tenant, ...request, notes: null,
    locality: null, province: null };
  assert.equal(verifyCreatedFarm({ data: stored, replayed: true }, request, tenant), stored);
  assert.throws(() => verifyCreatedFarm({ data: { ...stored, locality: 'injected' },
    replayed: true }, request, tenant), /no confirmó/i);
});

test('gate blocks simultaneous double POST and stale retry tickets', async () => {
  const gate = createFarmSubmitGate();
  const scope = farmCreateScope(session, 'live');
  let release;
  const remote = new Promise(resolve => { release = resolve; });
  const first = gate.acquire(scope);
  assert.ok(first);
  let posts = 0;
  const send = async ticket => { posts++; await remote; gate.finish(ticket, 'uncertain'); };
  const inFlight = send(first);
  assert.equal(gate.acquire(scope), null);
  assert.equal(gate.retry(scope), null);
  assert.equal(posts, 1);
  release();
  await inFlight;
  assert.equal(gate.acquire(scope), null);
  const retry = gate.retry(scope);
  assert.ok(retry);
  assert.equal(gate.retry(scope), null);
  assert.equal(gate.finish(first, 'confirmed'), false);
  assert.equal(gate.finish(retry, 'confirmed'), true);
  assert.equal(gate.retry(scope), null);
  gate.reset();
  assert.equal(gate.finish(retry, 'uncertain'), false);
});

test('farm modal uses scope-bound producer snapshot and same-body retry', () => {
  const jsx = readFileSync(new URL('../src/components/FarmFormModal.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /farmCreateScope\(session, dataMode\)/);
  assert.match(jsx, /requestApi\.producers\(\)/);
  assert.match(jsx, /scopeRef\.current === requestScope/);
  assert.match(jsx, /producerSnapshot\?\.scope === authority/);
  assert.match(jsx, /gate\.current\.acquire\(authority\)/);
  assert.match(jsx, /gate\.current\.retry\(authority\)/);
  assert.match(jsx, /sendCreate\(ticket, saved\.body, saved\.api\)/);
  assert.match(jsx, /verifyCreatedFarm\(response, body, session\?\.tenant\?\.id\)/);
  assert.match(jsx, /onClose=\{safeClose\}/);
  assert.doesNotMatch(jsx, /mockData/);
  assert.doesNotMatch(jsx, /api\.createFarm\(body\);\s*onCreated/);
});
