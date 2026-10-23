import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VALIDATION_NODES, withinValidationBudget, validate, HttpError
} from '../src/utils/http.js';

test('small request JSON, including mobile base64 photos, remains valid', () => {
  const photo = 'A'.repeat(2_796_204);
  for (const body of [
    null, { name: 'Lote Norte', campaign: 2026 },
    { observations: Array.from({ length: 50 }, (_, i) => ({ id: String(i), severity: 'low' })) },
    { operations: [{ payload: { notes: 'recorrida', content_base64: photo } }] }
  ]) assert.equal(withinValidationBudget(body), true);
});

test('an oversized flat array is rejected before per-item validation', () => {
  assert.equal(withinValidationBudget({ operations: Array(MAX_VALIDATION_NODES).fill(null) }), false);
  assert.equal(withinValidationBudget({ operations: Array.from({ length: 50 }, () => ({ status: 'pending' })) }), true);
});

test('oversized nested containers and object key fanout are also bounded', () => {
  assert.equal(withinValidationBudget({
    metadata: Object.fromEntries(Array.from({ length: MAX_VALIDATION_NODES }, (_, i) =>
      ['key_' + i, i]))
  }), false);
  const largeTree = { value: 1 };
  let top = largeTree;
  for (let i = 0; i < MAX_VALIDATION_NODES; i++) {
    top.child = { value: i };
    top = top.child;
  }
  assert.equal(withinValidationBudget(largeTree), false);
});

test('exact boundary nodes are accepted, then next node is rejected', () => {
  // One root + 4095 array members = 4096 nodes exactly.
  assert.equal(withinValidationBudget(Array(MAX_VALIDATION_NODES - 1).fill(0)), true);
  assert.equal(withinValidationBudget(Array(MAX_VALIDATION_NODES).fill(0)), false);
});

test('preflight refuses oversized inputs before calling Zod safeParse', () => {
  let invocations = 0;
  const schema = { safeParse() {
    invocations++;
    throw new Error('expensive parser should never run');
  } };
  const middleware = validate(schema);
  let error;
  const next = (err) => { error = err; };
  middleware({ body: { items: Array(MAX_VALIDATION_NODES).fill({ bad: true }) } }, {}, next);
  assert.equal(invocations, 0);
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 413);
  assert.equal(error.code, 'VALIDATION_BUDGET_EXCEEDED');
  assert.doesNotMatch(error.message, /items|bad/);
});

test('existing Zod success and error contracts survive below budget', () => {
  const req = { body: { quantity: '3' } };
  const middleware = validate({
    safeParse(body) {
      if (body.quantity === '3') return { success: true, data: { quantity: 3 } };
      return { success: false, error: { flatten: () => ({ fieldErrors: { quantity: ['invalid'] } }) } };
    }
  });
  let called = 0;
  middleware(req, {}, err => { called++; assert.equal(err, undefined); });
  assert.equal(called, 1);
  assert.deepEqual(req.body, { quantity: 3 });

  let validationError;
  middleware({ body: { quantity: 'oops' } }, {}, err => { validationError = err; });
  assert.ok(validationError instanceof HttpError);
  assert.equal(validationError.status, 422);
  assert.equal(validationError.code, 'VALIDATION_ERROR');
  assert.deepEqual(validationError.details, { fieldErrors: { quantity: ['invalid'] } });
});

test('query and route param validation also uses same finite budget', () => {
  const middleware = validate({ safeParse(payload) { return { success: true, data: payload }; } }, 'query');
  const req = { query: { sort: 'newest' } };
  let nextCalls = 0;
  middleware(req, {}, () => { nextCalls++; });
  assert.equal(nextCalls, 1);
  assert.deepEqual(req.query, { sort: 'newest' });
});

test('the guard accepts only acyclic bounded JSON-like structures', () => {
  const cycle = {};
  cycle.self = cycle;
  assert.equal(withinValidationBudget(cycle), false);
  assert.equal(withinValidationBudget({ prototype: '__proto__', nested: [true, false, null] }), true);
});
