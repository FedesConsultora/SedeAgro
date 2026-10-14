import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCollection } from '../src/services/useTenantCollection.js';
import { cloudCoverLabel, ndviMeanLabel } from '../src/services/satelliteMetadata.js';

test('business module response must be an explicit array, not an inferred empty collection', () => {
  assert.deepEqual(extractCollection({ data: [] }, 'lotes'), []);
  assert.deepEqual(extractCollection({ data: [{ id: 1 }] }, 'lotes'), [{ id: 1 }]);
  for (const payload of [null, undefined, {}, { data: null }, { data: {} }, { items: [] }]) {
    assert.throws(() => extractCollection(payload, 'lotes'), /lista válida/i);
  }
});

test('remote-sensing stats never invent average NDVI or cloud cover defaults', () => {
  for (const absent of [null, undefined, '', 'not-a-number', -4, 5]) {
    assert.equal(cloudCoverLabel(absent), 'No informado');
  }
  assert.equal(cloudCoverLabel(0), '0%');
  assert.equal(cloudCoverLabel(0.4), '40%');
  assert.equal(cloudCoverLabel(1), '100%');
  assert.equal(ndviMeanLabel(undefined), 'No informado');
  assert.equal(ndviMeanLabel(''), 'No informado');
  assert.equal(ndviMeanLabel(-1), '-1');
  assert.equal(ndviMeanLabel(0), '0');
  assert.equal(ndviMeanLabel(1), '1');
  assert.equal(ndviMeanLabel(1.5), 'No informado');
});
