import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_GPS_OPTIONS, MAX_FIELD_ACCURACY_METERS,
  confirmedFieldLocation, fieldGpsErrorMessage, validateObservationPoint
} from '../src/services/observationLocation.js';

const FIXED_TIME = Date.parse('2026-10-14T20:00:00.000Z');
const fix = (props = {}) => ({
  timestamp: FIXED_TIME - 1000,
  coords: { longitude: -57.9521, latitude: -34.9205, accuracy: 12.4, ...props.coords },
  ...Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'coords'))
});

test('GPS coordinates are GeoJSON lon/lat and accuracy is explicit', () => {
  assert.deepEqual(confirmedFieldLocation(fix(), FIXED_TIME), {
    point: { type: 'Point', coordinates: [-57.9521, -34.9205] },
    accuracyMeters: 12, capturedAt: '2026-10-14T19:59:59.000Z'
  });
  assert.equal(FIELD_GPS_OPTIONS.maximumAge, 0);
  assert.equal(FIELD_GPS_OPTIONS.enableHighAccuracy, true);
  assert.ok(FIELD_GPS_OPTIONS.timeout > 0);
});

test('GPS rejects missing, fake, malformed and out of-range coordinates', () => {
  for (const coords of [
    { longitude: -181 }, { longitude: 181 }, { latitude: -91 },
    { latitude: 91 }, { longitude: NaN }, { latitude: Infinity },
    { longitude: '123' }, { latitude: null }
  ]) assert.throws(() => confirmedFieldLocation(fix({ coords }), FIXED_TIME), /WGS84/);
  for (const point of [
    null, { type: 'Point', coordinates: [] },
    { type: 'LineString', coordinates: [-60, -34] },
    { type: 'Point', coordinates: [-60, -34, 5] },
    { type: 'Point', coordinates: [-60, -34], accuracy: 5 }
  ]) assert.throws(() => validateObservationPoint(point), /WGS84/);
});

test('GPS never accepts stale, future or misleading-accuracy fixes', () => {
  assert.equal(MAX_FIELD_ACCURACY_METERS, 150);
  for (const bad of [
    fix({ coords: { accuracy: 500 } }),
    fix({ coords: { accuracy: Infinity } }),
    fix({ coords: { accuracy: -1 } }),
    fix({ timestamp: FIXED_TIME - 180000 }),
    fix({ timestamp: FIXED_TIME + 6000 })
  ]) assert.throws(() => confirmedFieldLocation(bad, FIXED_TIME), /Precisión|precisión|reciente/);
});

test('GPS status explains permission, timeout and no-signal without making up a point', () => {
  assert.match(fieldGpsErrorMessage({ code: 1 }), /denegado/);
  assert.match(fieldGpsErrorMessage({ code: 2 }), /no pudo determinar/);
  assert.match(fieldGpsErrorMessage({ code: 3 }), /tiempo/);
  assert.match(fieldGpsErrorMessage(new Error('Sin soporte GPS')), /Sin soporte GPS/);
});
