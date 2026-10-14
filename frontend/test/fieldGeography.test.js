import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldGeography, parseFarmCentroid, parseFieldDetail } from '../src/services/fieldGeography.js';

const square = { type: 'Polygon', coordinates: [[
  [-60.2, -34.5], [-60.1, -34.5], [-60.1, -34.4], [-60.2, -34.4], [-60.2, -34.5]
]] };
const centroid = { type: 'Point', coordinates: [-60.15, -34.45] };

test('PostGIS polygon yields a bounded SVG path, actual bbox and actual OSM location', () => {
  const shape = fieldGeography(square, centroid);
  assert.equal(shape.kind, 'polygon');
  assert.equal(shape.bbox.west, -60.2);
  assert.equal(shape.bbox.north, -34.4);
  assert.equal(shape.rings, 1);
  assert.equal(shape.pointCount, 5);
  assert.match(shape.path, /^M\d/);
  assert.match(shape.url, /^https:\/\/www.openstreetmap.org\/#map=\d+\/-34\.450000\/-60\.150000$/);
  for (const n of shape.path.match(/-?\d+(?:\.\d+)?/g).map(Number)) {
    assert.ok(n >= 0 && n <= 400);
  }
});

test('holes are preserved as separate subpaths for SVG evenodd filling', () => {
  const hole = [[-60.18, -34.48], [-60.16, -34.48], [-60.16, -34.46], [-60.18, -34.46], [-60.18, -34.48]];
  const shape = fieldGeography({ ...square, coordinates: [...square.coordinates, hole] });
  assert.equal(shape.kind, 'polygon');
  assert.equal(shape.rings, 2);
  assert.equal((shape.path.match(/M/g) || []).length, 2);
});

test('no polygon cannot be fabricated from farm centroid', () => {
  const info = fieldGeography(null, centroid);
  assert.equal(info.kind, 'absent');
  assert.ok(info.farmUrl.includes('-34.450000/-60.150000'));
  assert.equal(info.path, undefined);
  assert.match(info.reason, /no tiene un perímetro/);
});

test('invalid geometry and coordinates never turn into a visible perimeter', () => {
  const bad = [
    {}, { type: 'LineString', coordinates: square.coordinates },
    { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [[[1, 2], [3, 4], [5, 6], [1, 2]]] },
    { type: 'Polygon', coordinates: [[[-181, -35], [-60, -35], [-60, -34], [-181, -35]]] },
    { type: 'Polygon', coordinates: [[[NaN, -34], [-60, -34], [-60, -33], [NaN, -34]]] },
    { type: 'Polygon', coordinates: [[[-60, -34], [-60.1, -34], [-60.1, -34.1], [-60, -34]]] , srid: 3857 },
    { type: 'Polygon', coordinates: [[[179, -34], [-179, -34], [-179, -35], [179, -34]]] }
  ];
  for (const p of bad) {
    const result = fieldGeography(p);
    assert.equal(result.kind, 'invalid');
    assert.equal(result.path, undefined);
    assert.equal(result.url, undefined);
  }
});

test('missing centroid and invalid coordinate metadata are never treated as a location', () => {
  assert.equal(parseFarmCentroid(null), null);
  assert.equal(parseFarmCentroid({ type: 'Point', coordinates: [-60, 91] }), null);
  assert.equal(parseFarmCentroid({ type: 'Point', coordinates: [null, -34] }), null);
  assert.deepEqual(parseFarmCentroid(centroid), { longitude: -60.15, latitude: -34.45 });
});

test('field detail rejects mismatched field or farm, not just an empty API result', () => {
  const field = { id: 'field-1', farm_id: 'farm-1', name: 'Lote 12', boundary: square };
  assert.deepEqual(parseFieldDetail({ data: field }, 'field-1', 'farm-1'), field);
  for (const response of [
    null, {}, { data: { ...field, id: 'other' } },
    { data: { ...field, farm_id: 'other' } },
    { data: { ...field, name: null } }
  ]) {
    assert.throws(() => parseFieldDetail(response, 'field-1', 'farm-1'), /detalle de lote inválido/);
  }
});
