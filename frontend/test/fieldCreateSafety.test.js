import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fieldCreateScope, prepareFieldCreate, verifyCreatedField, createFieldSubmitGate
} from '../src/services/fieldCreateSafety.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const farm = 'b5f05b5f-1132-4342-b385-c004443f2cd9';
const newField = '4b73e9e8-9375-41db-a574-7bbb38381704';
const other = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: other, roleCode: 'agronomic_coordinator' },
  entitlements: ['gis', 'campaigns'] };
const farms = [{ id: farm, tenant_id: tenant, name: 'Establecimiento Sur' }];
const form = { farm_id: farm, name: ' Lote 4 Norte ', area_hectares: '82.5',
  status: 'active', notes: '  Cerca del molino  ' };
const request = { farm_id: farm, name: 'Lote 4 Norte', area_hectares: 82.5,
  status: 'active', notes: 'Cerca del molino' };
const reply = { data: { id: newField, tenant_id: tenant, ...request,
  area_hectares: '82.50', boundary: null } };

test('creation scope binds live company, actor, role and selected parent', () => {
  const scope = fieldCreateScope(session, 'live', farm);
  assert.ok(scope);
  assert.equal(fieldCreateScope({ ...session, entitlements: ['campaigns', 'gis', 'gis'] },
    'live', farm), scope);
  for (const patch of [
    { tenant: { id: other } }, { user: { id: other } },
    { membership: { id: farm, roleCode: 'agronomic_coordinator' } },
    { membership: { id: other, roleCode: 'tenant_admin' } },
    { entitlements: ['gis'] }
  ]) assert.notEqual(fieldCreateScope({ ...session, ...patch }, 'live', farm), scope);
  for (const patch of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: { id: farm, roleCode: 'scout' } },
    { membership: null }, { entitlements: [] }, { entitlements: null }
  ]) assert.equal(fieldCreateScope({ ...session, ...patch }, 'live', farm), null);
  assert.equal(fieldCreateScope(session, 'mock', farm), null);
  assert.equal(fieldCreateScope(session, 'live', 'invalid'), null);
  assert.notEqual(fieldCreateScope(session, 'live', other), scope);
  assert.ok(fieldCreateScope(session, 'live', undefined), 'global farm picker has authority');
});

test('body normalizes name, exact 2-decimal area and optional notes; preserves zero', () => {
  assert.deepEqual(prepareFieldCreate(form, farms, tenant), request);
  assert.deepEqual(prepareFieldCreate({
    ...form, area_hectares: '', notes: ' '
  }, farms, tenant), { farm_id: farm, name: 'Lote 4 Norte', area_hectares: 0, status: 'active' });
  assert.equal(prepareFieldCreate({
    ...form, area_hectares: '0.00'
  }, farms, tenant).area_hectares, 0);
  assert.equal(prepareFieldCreate({
    ...form, area_hectares: '0.01'
  }, farms, tenant).area_hectares, 0.01);
});

test('reject unknown farm or foreign tenant; preselected parent remains server-authorized', () => {
  for (const patch of [
    { farm_id: other }, { farm_id: 'bad' }
  ]) assert.throws(() => prepareFieldCreate({ ...form, ...patch }, farms, tenant),
    /establecimiento|empresa/i);
  assert.throws(() => prepareFieldCreate(form,
    [{ id: farm, tenant_id: other }], tenant), /empresa/i);
  assert.throws(() => prepareFieldCreate(form, null, tenant), /empresa/i);
  assert.throws(() => prepareFieldCreate(form, farms, other), /empresa/i);
  assert.equal(prepareFieldCreate(form, [], tenant, farm).farm_id, farm);
  assert.throws(() => prepareFieldCreate(form, [], tenant, 'bad'), /establecimiento/i);
});

test('reject malformed area rather than converting it to zero', () => {
  for (const area of ['abc', '-1', '1.999', '1e6', 'Infinity', '10000000000.00', '2,5']) {
    assert.throws(() => prepareFieldCreate({ ...form, area_hectares: area }, farms, tenant),
      /superficie/i);
  }
  for (const patch of [
    { name: '   ' }, { name: 'X'.repeat(181) }, { status: 'closed' }, { notes: 123 }
  ]) assert.throws(() => prepareFieldCreate({ ...form, ...patch }, farms, tenant),
    /nombre|estado|notas/i);
});

test('ACK must contain exact UUID tenant farm name area status and notes', () => {
  assert.equal(verifyCreatedField(reply, request, tenant), reply.data);
  for (const patch of [
    { id: 'not-uuid' }, { tenant_id: other }, { farm_id: other },
    { name: 'Otro lote' }, { area_hectares: '83.00' },
    { area_hectares: null }, { status: 'archived' }, { notes: null }
  ]) assert.throws(() => verifyCreatedField({
    data: { ...reply.data, ...patch }
  }, request, tenant), /no confirmó/i);
  for (const invalid of [null, {}, { data: [] }, { data: null }, { data: {} }]) {
    assert.throws(() => verifyCreatedField(invalid, request, tenant), /no confirmó/i);
  }
});

test('ACK of default zero area with null notes is still confirmed', () => {
  const body = { farm_id: farm, name: 'Lote vacío', area_hectares: 0, status: 'active' };
  const row = { id: newField, tenant_id: tenant, ...body, area_hectares: '0.00', notes: null };
  assert.equal(verifyCreatedField({ data: row }, body, tenant), row);
  assert.throws(() => verifyCreatedField({ data: { ...row, notes: 'unexpected' } }, body, tenant),
    /no confirmó/i);
});

test('simultaneous click before rerender dispatches at most one POST', async () => {
  const scope = fieldCreateScope(session, 'live', farm);
  const gate = createFieldSubmitGate();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let posts = 0;
  const submit = async () => {
    const ticket = gate.acquire(scope);
    if (!ticket) return 'blocked';
    posts++;
    await pending;
    verifyCreatedField(reply, request, tenant);
    gate.finish(ticket, 'confirmed');
    return 'confirmed';
  };
  const first = submit();
  assert.equal(await submit(), 'blocked');
  assert.equal(posts, 1);
  release();
  assert.equal(await first, 'confirmed');
  assert.equal(await submit(), 'blocked');
  gate.reset();
  const uncertain = gate.acquire(scope);
  assert.ok(uncertain);
  assert.equal(gate.finish(uncertain, 'uncertain'), true);
  assert.equal(gate.acquire(scope), null);
});

test('stale async result cannot affect newly opened modal', () => {
  const gate = createFieldSubmitGate();
  const old = gate.acquire(fieldCreateScope(session, 'live', farm));
  gate.reset();
  const currentScope = fieldCreateScope({ ...session, tenant: { id: other } }, 'live', farm);
  const active = gate.acquire(currentScope);
  assert.equal(gate.finish(old, 'confirmed'), false);
  assert.equal(gate.isPending(currentScope), true);
  assert.equal(gate.finish(active, 'confirmed'), true);
});

test('modal protects tenant-bound farm options, receipt, demo and all close paths', () => {
  const source = readFileSync(new URL('../src/components/FieldFormModal.jsx', import.meta.url), 'utf8');
  assert.match(source, /fieldCreateScope\(session, dataMode, preselectedFarmId\)/);
  assert.match(source, /requestApi\.farms\(\)/);
  assert.match(source, /scopeRef\.current === requestScope/);
  assert.match(source, /gate\.current\.acquire\(authority\)/);
  assert.match(source, /prepareFieldCreate\(form, farms, session\?\.tenant\?\.id, preselectedFarmId\)/);
  assert.match(source, /verifyCreatedField\(response, body, session\?\.tenant\?\.id\)/);
  assert.match(source, /onClose=\{safeClose\}/);
  assert.doesNotMatch(source, /mockData\./);
  assert.doesNotMatch(source, /dataMode === 'mock'\) \{ onCreated/);
});
