import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { quantityUnits, unitsString, buildInputDeclaration,
  sameInputDeclaration, hasRequiredInputDeclaration } from '../src/modules/workOrders/inputDeclarationPolicy.js';

const id1 = randomUUID(), id2 = randomUUID(), user = randomUUID(), uuid = randomUUID();
const rows = [
  { id: id1, input_id: 'product1', total_quantity: '6.5000',
    AgriculturalInput: { id: 'product1', name: 'Fertilizante', unit: 'kg' } },
  { id: id2, input_id: 'product2', total_quantity: '2.0000',
    AgriculturalInput: { id: 'product2', name: 'Coadyuvante', unit: 'L' } }
];
const payload = { client_declaration_id: uuid, notes: 'Se aplicó menos por limitaciones del sector.',
  items: [
    { work_order_input_id: id2, declared_quantity: '0.5000' },
    { work_order_input_id: id1, declared_quantity: '6.5000' }
  ]
};

test('exact four-decimal arithmetic never converts kg to liters or rounds a delta', () => {
  assert.equal(quantityUnits('0.0001'), 1);
  assert.equal(quantityUnits('99999999.9999'), 999999999999);
  assert.equal(unitsString(1), '0.0001');
  assert.equal(unitsString(-15000), '-1.5');
  assert.equal(unitsString(0), '0');
  for (const invalid of [1, '', '-1', '+1', 'NaN', 'Infinity', '1e2', '1.00000',
    '100000000', '01', '.5', '2,50']) {
    assert.throws(() => quantityUnits(invalid), /Cantidad/);
  }
});

test('a reported snapshot freezes catalog name/unit, plan, declared and variance with server identity', () => {
  const at = new Date('2026-10-16T13:00:00.000Z');
  const declaration = buildInputDeclaration({ rows, payload, userId: user, timestamp: at });
  assert.equal(declaration.declared_by, user);
  assert.equal(declaration.declared_at, at.toISOString());
  assert.equal(declaration.client_declaration_id, uuid);
  const a = declaration.items.find(row => row.work_order_input_id === id1);
  const b = declaration.items.find(row => row.work_order_input_id === id2);
  assert.deepEqual([a.name, a.unit, a.planned_quantity, a.declared_quantity, a.variance_quantity],
    ['Fertilizante', 'kg', '6.5', '6.5', '0']);
  assert.deepEqual([b.unit, b.planned_quantity, b.declared_quantity, b.variance_quantity],
    ['L', '2', '0.5', '-1.5']);
  assert.equal(sameInputDeclaration(declaration, payload), true);
  assert.equal(sameInputDeclaration(declaration, { ...payload, client_declaration_id: randomUUID() }), false);
  assert.equal(sameInputDeclaration(declaration, { ...payload, items: payload.items.map(x => ({
    ...x, declared_quantity: '0' })) }), false);
});

test('never accept unplanned, incomplete, duplicate or silent variance payload', () => {
  const args = { rows, payload, userId: user };
  assert.throws(() => buildInputDeclaration({ ...args,
    payload: { ...payload, items: [payload.items[0]] } }), /exactamente/i);
  assert.throws(() => buildInputDeclaration({ ...args,
    payload: { ...payload, items: [payload.items[0], payload.items[0]] } }), /repetido/i);
  assert.throws(() => buildInputDeclaration({ ...args,
    payload: { ...payload, items: [
      payload.items[0], { work_order_input_id: randomUUID(), declared_quantity: '2' }
    ] } }), /plan vigente/i);
  assert.throws(() => buildInputDeclaration({ ...args,
    payload: { ...payload, notes: 'sin notas' } }), /Explicá/);
  assert.throws(() => buildInputDeclaration({ ...args,
    rows: Array.from({ length: 26 }, (_, i) => ({ ...rows[0], id: String(i) })) }), /25/);
});

test('an exact report counts only as declared when plan lines match; historical NULL means missing', () => {
  assert.equal(hasRequiredInputDeclaration(0, null), true);
  assert.equal(hasRequiredInputDeclaration(2, { input_declaration: null }), false);
  assert.equal(hasRequiredInputDeclaration(2, { input_declaration: { items: rows } }), true);
  assert.equal(hasRequiredInputDeclaration(2, { input_declaration: { items: [rows[0]] } }), false);
});
