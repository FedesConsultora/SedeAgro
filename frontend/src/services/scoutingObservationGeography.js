import { fieldGeography, projectFieldPosition } from './fieldGeography.js';
import { validateObservationPoint } from './observationLocation.js';

const WIDTH = 400;
const HEIGHT = 240;
const MARGIN = 22;
export const MAX_LOCATION_MARKERS = 150;

export const GEO_STATUS = Object.freeze({
  inside: 'Dentro del perímetro registrado',
  border: 'Sobre el límite registrado',
  outside: 'Fuera del perímetro registrado',
  located: 'GPS registrado · sin perímetro del lote',
  unprojected: 'GPS registrado · perímetro no representable',
  missing: 'Sin GPS registrado',
  invalid: 'Coordenadas no válidas'
});

function pointOnSegment([x, y], [ax, ay], [bx, by]) {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  const size = Math.hypot(bx - ax, by - ay);
  if (size === 0 || Math.abs(cross) > 1e-10 * size) return false;
  return x >= Math.min(ax, bx) - 1e-10 && x <= Math.max(ax, bx) + 1e-10 &&
    y >= Math.min(ay, by) - 1e-10 && y <= Math.max(ay, by) + 1e-10;
}

function ringContains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (pointOnSegment([x, y], a, b)) return 'border';
    if ((a[1] > y) !== (b[1] > y) &&
      x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export function locationInField(boundary, point) {
  const coordinates = validateObservationPoint(point).coordinates;
  if (fieldGeography(boundary).kind !== 'polygon') return null;
  let inside = false;
  for (const ring of boundary.coordinates) {
    const hit = ringContains(ring, coordinates);
    if (hit === 'border') return 'border';
    if (hit) inside = !inside; // even-odd, including interior holes
  }
  return inside ? 'inside' : 'outside';
}

function scatterPositions(entries) {
  const coords = entries.filter(row => row.point).map(row => row.point.coordinates);
  if (!coords.length) return null;
  const longs = coords.map(p => p[0]);
  const lats = coords.map(p => p[1]);
  const west = Math.min(...longs);
  const east = Math.max(...longs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const latCenter = (north + south) / 2;
  // Refuse misleading planar plots across the antimeridian or huge regions.
  if (east - west > 10 || north - south > 10 || Math.abs(latCenter) > 85) return null;
  const lonScale = Math.cos(latCenter * Math.PI / 180);
  const cx = (east + west) / 2;
  const cy = latCenter;
  const width = Math.max((east - west) * lonScale, 0.001);
  const height = Math.max(north - south, 0.001);
  const scale = Math.min((WIDTH - 2 * MARGIN) / width,
    (HEIGHT - 2 * MARGIN) / height);
  return (point) => ({
    x: Number((WIDTH / 2 + (point[0] - cx) * lonScale * scale).toFixed(2)),
    y: Number((HEIGHT / 2 - (point[1] - cy) * scale).toFixed(2))
  });
}

export function observationMapUrl(point) {
  const coords = validateObservationPoint(point).coordinates;
  return `https://www.openstreetmap.org/#map=17/${coords[1].toFixed(6)}/${coords[0].toFixed(6)}`;
}

export function scoutingObservationGeography(observations, boundary) {
  if (!Array.isArray(observations)) throw new Error('Las observaciones no son una colección válida.');
  const field = fieldGeography(boundary);
  const rows = observations.map((observation, index) => {
    if (!observation || typeof observation.id !== 'string' || !observation.id) {
      throw new Error('Se encontró una observación sin identidad verificable.');
    }
    let point = null;
    let status = 'missing';
    if (observation.point !== null && observation.point !== undefined) {
      try {
        point = validateObservationPoint(observation.point);
        status = field.kind === 'polygon'
          ? locationInField(boundary, point)
          : field.kind === 'absent' ? 'located' : 'unprojected';
      } catch {
        status = 'invalid';
      }
    }
    return {
      id: observation.id,
      order: index + 1,
      type: observation.observation_type,
      severity: observation.severity,
      observedAt: observation.observed_at,
      point,
      status,
      position: null
    };
  });
  const mapMode = field.kind === 'polygon' ? 'field' :
    field.kind === 'absent' ? 'gps' : 'unavailable';
  const gpsProject = mapMode === 'gps' ? scatterPositions(rows) : null;
  const canPlot = mapMode === 'field' || Boolean(gpsProject);
  for (const row of rows) {
    if (!row.point || !canPlot || (mapMode === 'field' && row.status === 'outside')) continue;
    const coords = row.point.coordinates;
    const xy = mapMode === 'field'
      ? projectFieldPosition(field, coords)
      : gpsProject(coords);
    if (xy && xy.x >= 0 && xy.x <= WIDTH && xy.y >= 0 && xy.y <= HEIGHT) {
      row.position = xy;
    }
  }
  const totals = Object.fromEntries(Object.keys(GEO_STATUS).map(key =>
    [key, rows.filter(row => row.status === key).length]));
  const plotted = rows.filter(row => row.position !== null).slice(0, MAX_LOCATION_MARKERS);
  return {
    field, rows, totals, plotted,
    skippedMarkers: rows.filter(row => row.position !== null).length - plotted.length,
    mode: canPlot ? mapMode : 'unavailable'
  };
}
