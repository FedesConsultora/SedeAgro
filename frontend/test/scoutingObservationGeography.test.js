import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldGeography, projectFieldPosition } from '../src/services/fieldGeography.js';
import {
  GEO_STATUS, MAX_LOCATION_MARKERS, locationInField,
  observationMapUrl, scoutingObservationGeography
} from '../src/services/scoutingObservationGeography.js';

const polygon = {
  type: 'Polygon',
  coordinates: [[
    [-60.2, -34.5], [-60.1, -34.5], [-60.1, -34.4],
    [-60.2, -34.4], [-60.2, -34.5]
  ], [
    [-60.18, -34.48], [-60.16, -34.48], [-60.16, -34.46],
    [-60.18, -34.46], [-60.18, -34.48]
  ]]
};
const point = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] });
const row = (id, p) => ({
  id, point: p, observation_type: 'pest', severity: 'high', observed_at: '2026-10-14T12:00:00Z'
});

test('shared field projection puts recorded points into same SVG coordinate frame as perimeter', () => {
  const shape = fieldGeography(polygon);
  assert.equal(shape.kind, 'polygon');
  const southwest = projectFieldPosition(shape, [-60.2, -34.5]);
  const northeast = projectFieldPosition(shape, [-60.1, -34.4]);
  assert.ok(southwest.x < northeast.x);
  assert.ok(southwest.y > northeast.y);
  for (const item of [southwest, northeast]) {
    assert.ok(item.x >= 0 && item.x <= 400);
    assert.ok(item.y >= 0 && item.y <= 240);
  }
  assert.equal(projectFieldPosition(shape, [Infinity, -34.4]), null);
  assert.equal(projectFieldPosition(fieldGeography(null), [-60.1, -34.4]), null);
});

test('inside, border, hole and outside are distinguished using actual GeoJSON rings', () => {
  assert.equal(locationInField(polygon, point(-60.19, -34.49)), 'inside');
  assert.equal(locationInField(polygon, point(-60.17, -34.47)), 'outside',
    'a hole must not be displayed as inside the field');
  assert.equal(locationInField(polygon, point(-60.1, -34.45)), 'border');
  assert.equal(locationInField(polygon, point(-60.18, -34.47)), 'border');
  assert.equal(locationInField(polygon, point(-60.25, -34.45)), 'outside');
});

test('authorized observations yield truthful marker counts; hole/outside are not drawn on field', () => {
  const result = scoutingObservationGeography([
    row('in', point(-60.19, -34.49)),
    row('hole', point(-60.17, -34.47)),
    row('edge', point(-60.1, -34.45)),
    row('out', point(-60.25, -34.45)),
    row('unlocated', null),
    row('invalid', { type: 'Point', coordinates: [-190, -34] })
  ], polygon);
  assert.equal(result.mode, 'field');
  assert.equal(result.rows.length, 6);
  assert.equal(result.totals.inside, 1);
  assert.equal(result.totals.border, 1);
  assert.equal(result.totals.outside, 2);
  assert.equal(result.totals.missing, 1);
  assert.equal(result.totals.invalid, 1);
  assert.deepEqual(result.plotted.map(x => x.id), ['in', 'edge']);
  assert.ok(result.rows.find(x => x.id === 'out').position === null);
  assert.ok(result.rows.find(x => x.id === 'invalid').point === null);
  assert.match(GEO_STATUS.outside, /Fuera/);
});

test('absent field boundary plots only actual GPS locations, without inventing perimeter', () => {
  const result = scoutingObservationGeography([
    row('first', point(-60.15, -34.45)),
    row('second', point(-60.16, -34.46)),
    row('none', undefined)
  ], null);
  assert.equal(result.field.kind, 'absent');
  assert.equal(result.mode, 'gps');
  assert.equal(result.totals.located, 2);
  assert.equal(result.totals.missing, 1);
  assert.equal(result.plotted.length, 2);
  for (const marker of result.plotted) {
    assert.ok(marker.position.x >= 0 && marker.position.x <= 400);
    assert.ok(marker.position.y >= 0 && marker.position.y <= 240);
  }
});

test('one GPS point is still plotted without fabricating a boundary or a second GPS', () => {
  const result = scoutingObservationGeography([row('single', point(-60.15, -34.45))]);
  assert.equal(result.mode, 'gps');
  assert.deepEqual(result.plotted[0].position, { x: 200, y: 120 });
  assert.equal(result.rows.length, 1);
});

test('invalid perimeter, dateline-spanning points and polar distortion never draw a fake sketch', () => {
  const badBoundary = { type: 'LineString', coordinates: [[-60, -34], [-59, -34]] };
  const badShape = scoutingObservationGeography([row('goodGPS', point(-60, -34))], badBoundary);
  assert.equal(badShape.field.kind, 'invalid');
  assert.equal(badShape.mode, 'unavailable');
  assert.equal(badShape.totals.unprojected, 1);
  assert.equal(badShape.plotted.length, 0);
  const global = scoutingObservationGeography([row('a', point(179, -34)), row('b', point(-179, -34))]);
  assert.equal(global.mode, 'unavailable');
  assert.equal(global.plotted.length, 0);
  const polar = scoutingObservationGeography([row('p', point(0, 86))]);
  assert.equal(polar.mode, 'unavailable');
});

test('coordinate export is only a deliberate external OpenStreetMap hyperlink', () => {
  assert.equal(observationMapUrl(point(-57.9521, -34.9205)),
    'https://www.openstreetmap.org/#map=17/-34.920500/-57.952100');
  assert.throws(() => observationMapUrl({ type: 'Point', coordinates: [200, -34] }), /WGS84/);
});

test('marker count stays bounded without hiding omitted data or modifying observation records', () => {
  const input = Array.from({ length: MAX_LOCATION_MARKERS + 5 }, (_, i) =>
    row('obs-' + i, point(-60.19, -34.49)));
  const v = scoutingObservationGeography(input, polygon);
  assert.equal(v.rows.length, MAX_LOCATION_MARKERS + 5);
  assert.equal(v.plotted.length, MAX_LOCATION_MARKERS);
  assert.equal(v.skippedMarkers, 5);
  assert.equal(v.totals.inside, MAX_LOCATION_MARKERS + 5);
  assert.equal(input[0].point.coordinates.length, 2);
});

test('incomplete observations fail closed, but missing GPS is not treated as invalid', () => {
  assert.throws(() => scoutingObservationGeography(null), /colección válida/);
  assert.throws(() => scoutingObservationGeography([{ point: null }]), /identidad verificable/);
  const v = scoutingObservationGeography([row('noGPS', null), row('badGPS', point(NaN, 2))]);
  assert.equal(v.mode, 'unavailable');
  assert.equal(v.totals.missing, 1);
  assert.equal(v.totals.invalid, 1);
});
