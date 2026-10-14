// GeoJSON/PostGIS read-only presentation. Coordinates are [longitude, latitude]
// in EPSG:4326. This never invents boundaries or calculates cadastral area.
const VIEW_WIDTH = 400;
const VIEW_HEIGHT = 240;
const MARGIN = 22;
const MAX_POINTS = 5000;
const formatPoint = (value) => Number(value.toFixed(2));

function isLonLat(value) {
  return Array.isArray(value) && value.length === 2 &&
    value.every((number) => typeof number === 'number' && Number.isFinite(number)) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

export function parseFarmCentroid(value) {
  if (value == null) return null;
  if (value?.type !== 'Point' || !isLonLat(value.coordinates)) return null;
  const [longitude, latitude] = value.coordinates;
  return { latitude, longitude };
}

export function parseFieldDetail(response, expectedFieldId, expectedFarmId) {
  const field = response?.data;
  if (!field || typeof field !== 'object' || Array.isArray(field) ||
      !expectedFieldId || field.id !== expectedFieldId ||
      !expectedFarmId || field.farm_id !== expectedFarmId ||
      typeof field.name !== 'string') {
    throw new Error('El servidor devolvió un detalle de lote inválido o de otro establecimiento.');
  }
  return field;
}

function validPolygon(boundary) {
  if (boundary?.type !== 'Polygon' || !Array.isArray(boundary.coordinates) ||
      boundary.coordinates.length < 1 || boundary.coordinates.length > 100 ||
      boundary.srid && boundary.srid !== 4326) return false;
  let points = 0;
  return boundary.coordinates.every((ring) => {
    if (!Array.isArray(ring) || ring.length < 4 || (points += ring.length) > MAX_POINTS ||
        !ring.every(isLonLat)) return false;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) return false;
    // A closed ring needs at least three different positions.
    return new Set(ring.slice(0, -1).map(p => p.join(','))).size >= 3;
  });
}

function osmUrl(latitude, longitude, longitudeSpan = 0, latitudeSpan = 0) {
  const span = Math.max(longitudeSpan * Math.cos(latitude * Math.PI / 180), latitudeSpan, 0.001);
  const zoom = Math.max(5, Math.min(17, Math.floor(Math.log2(120 / span))));
  return `https://www.openstreetmap.org/#map=${zoom}/${latitude.toFixed(6)}/${longitude.toFixed(6)}`;
}

export function fieldGeography(boundary, farmCentroid = null) {
  const farmPoint = parseFarmCentroid(farmCentroid);
  if (boundary == null) {
    return {
      kind: 'absent',
      reason: 'Este lote todavía no tiene un perímetro georreferenciado.',
      farmPoint,
      farmUrl: farmPoint ? osmUrl(farmPoint.latitude, farmPoint.longitude) : null
    };
  }
  if (!validPolygon(boundary)) {
    return { kind: 'invalid', reason: 'El perímetro guardado no tiene geometría GeoJSON Polygon EPSG:4326 válida para esta vista.', farmPoint, farmUrl: null };
  }

  const coordinates = boundary.coordinates.flat();
  const lngs = coordinates.map(p => p[0]);
  const lats = coordinates.map(p => p[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const latitude = (minLat + maxLat) / 2;
  const longitude = (minLng + maxLng) / 2;
  // A single planar drawing would cross the antimeridian or collapse at the poles.
  const longitudeScale = Math.cos(latitude * Math.PI / 180);
  const dx = (maxLng - minLng) * longitudeScale;
  const dy = maxLat - minLat;
  if (maxLng - minLng > 180 || dx < 1e-9 || dy < 1e-9 ||
      Math.abs(latitude) > 85) {
    return { kind: 'invalid', reason: 'El perímetro no se puede representar de forma fiel en este croquis local.', farmPoint, farmUrl: null };
  }

  const scale = Math.min((VIEW_WIDTH - MARGIN * 2) / dx, (VIEW_HEIGHT - MARGIN * 2) / dy);
  const offsetX = (VIEW_WIDTH - dx * scale) / 2;
  const offsetY = (VIEW_HEIGHT - dy * scale) / 2;
  const path = boundary.coordinates.map(ring =>
    ring.map(([lng, lat], i) =>
      `${i ? 'L' : 'M'}${formatPoint(offsetX + (lng - minLng) * longitudeScale * scale)} ${formatPoint(offsetY + (maxLat - lat) * scale)}`
    ).join(' ') + ' Z'
  ).join(' ');

  return {
    kind: 'polygon',
    path,
    rings: boundary.coordinates.length,
    pointCount: coordinates.length,
    bbox: { west: minLng, south: minLat, east: maxLng, north: maxLat },
    center: { latitude, longitude },
    url: osmUrl(latitude, longitude, maxLng - minLng, maxLat - minLat),
    // Farm point remains independent; it is never implied to lie within this lot.
    farmPoint
  };
}
