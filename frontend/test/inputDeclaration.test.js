import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plannedInputs, canReportInputs, validateInputDeclarationPayload,
  validateInputDeclarationResponse, hasPlannedInputsWithoutDeclaration }
  from '../src/services/inputDeclaration.js';

const id1 = 'a', id2 = 'b';
const plan = [{ id: id1, total_quantity: '6.5', AgriculturalInput: { name: 'Fertilizante', unit: 'kg' } },
  { id: id2, total_quantity: '2', AgriculturalInput: { name: 'Adyuvante', unit: 'L' } }];
const order = { id: 'order1', status: 'in_progress', WorkOrderInputs: plan };
const report = { id: 'report1', work_order_id: 'order1', submitted_by: 'worker', review_status: 'submitted' };

test('only the author of a pending live report sees material declaration action', () => {
  assert.equal(canReportInputs(order, report, 'worker', true), true);
  assert.equal(canReportInputs(order, report, 'different', true), false);
  assert.equal(canReportInputs(order, report, 'worker', false), false);
  assert.equal(canReportInputs({ ...order, status: 'completed' }, report, 'worker', true), false);
  assert.equal(canReportInputs(order, { ...report, review_status: 'verified' }, 'worker', true), false);
  assert.equal(canReportInputs(order, { ...report, input_declaration: { items: plan } }, 'worker', true), false);
  assert.equal(hasPlannedInputsWithoutDeclaration(order, report), true);
  assert.equal(hasPlannedInputsWithoutDeclaration(order, { ...report, input_declaration: { items: plan } }), false);
  assert.deepEqual(plannedInputs({}), []);
});

test('quantities are strings with exact max four decimal positions and no cross-unit arithmetic', () => {
  const payload = validateInputDeclarationPayload(plan, { a: '6.5000', b: '0.5' }, 'Observé menos líquido.', 'uuid1');
  assert.deepEqual(payload.items, [
    { work_order_input_id: 'a', declared_quantity: '6.5000' },
    { work_order_input_id: 'b', declared_quantity: '0.5' }
  ]);
  assert.equal(payload.client_declaration_id, 'uuid1');
  assert.throws(() => validateInputDeclarationPayload(plan, { a: '-1', b: '2' }, '', 'uuid'), /cuatro decimales/);
  assert.throws(() => validateInputDeclarationPayload(plan, { a: '1e3', b: '2' }, '', 'uuid'), /cuatro decimales/);
  assert.throws(() => validateInputDeclarationPayload(plan, { a: '1.12345', b: '2' }, '', 'uuid'), /cuatro decimales/);
  assert.throws(() => validateInputDeclarationPayload(plan, { a: '1' }, '', 'uuid'), /cada cantidad/);
});

test('a successful write requires the exact server-confirmed report and client UUID', () => {
  const response = { data: { ...report, input_declaration: { client_declaration_id: 'uuid1', items: [] } } };
  assert.deepEqual(validateInputDeclarationResponse(response, 'order1', 'report1', 'uuid1'), response.data);
  assert.throws(() => validateInputDeclarationResponse(response, 'other', 'report1', 'uuid1'), /no confirmó/);
  assert.throws(() => validateInputDeclarationResponse(response, 'order1', 'other', 'uuid1'), /no confirmó/);
  assert.throws(() => validateInputDeclarationResponse(response, 'order1', 'report1', 'other'), /no confirmó/);
});

test('UI groups plan snapshot per report and disables positive review until declared', () => {
  const ui = readFileSync(new URL('../src/components/WorkOrderExecutionInputs.jsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /clientId \|\| crypto.randomUUID\(\)/);
  assert.match(ui, /\/input-declaration/);
  assert.match(ui, /validateInputDeclarationResponse/);
  assert.match(ui, /planificada y la informada/);
  assert.match(panel, /<WorkOrderExecutionInputs order=\{order\} report=\{report\}/);
  assert.match(panel, /hasPlannedInputsWithoutDeclaration\(order, report\)/);
});
