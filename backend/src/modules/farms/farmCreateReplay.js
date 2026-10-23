// 0U.19 — compare authored farm creation with its persisted immutable identity.
// Never mutate an existing farm to satisfy a retried POST. In particular, its
// producer determines granted visibility into historical fields and observations.
function pointCoordinates(value) {
  if (value == null) return null;
  if (value.type !== 'Point' || !Array.isArray(value.coordinates) ||
      value.coordinates.length !== 2) return undefined;
  return value.coordinates;
}

export function sameFarmCreation(farm, payload) {
  if (!farm || !payload || farm.name !== payload.name) return false;
  const fields = ['producer_id', 'locality', 'province', 'country', 'notes'];
  if (!fields.every(field => (farm[field] ?? null) === (payload[field] ?? null))) return false;

  // Sequelize returns a GeoJSON Point for PostGIS geometry(Point,4326); authored
  // SRID:4326 is optional and cannot distinguish two otherwise identical fixes.
  const stored = pointCoordinates(farm.centroid);
  const requested = pointCoordinates(payload.centroid);
  if (stored === undefined || requested === undefined) return false;
  if (stored === null || requested === null) return stored === requested;
  return stored[0] === requested[0] && stored[1] === requested[1];
}
