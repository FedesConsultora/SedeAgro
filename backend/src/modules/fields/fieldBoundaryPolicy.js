// Validate authored WGS84 Polygon GeoJSON before PostGIS persistence.
// This complements (but does not replace) the database's geometry(Polygon,4326).
import { z } from 'zod';
import { QueryTypes } from 'sequelize';
import { queryTenantTransaction } from '../../infra/db/rawScope.js';
import { HttpError } from '../../utils/http.js';

const pointSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90)
]);

const MAX_RINGS = 100;
const MAX_POINTS = 5000;
const MIN_DOUBLE_AREA = 1e-16;

const ringSchema = z.array(pointSchema).min(4).max(MAX_POINTS).superRefine((ring, ctx) => {
  if (ring.length < 4) return;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Cada anillo debe finalizar en la misma coordenada en la que comenzó.' });
  }
  const distinct = new Set(ring.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`));
  if (distinct.size < 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Cada anillo necesita tres posiciones distintas como mínimo.' });
  }
  let doubleArea = 0;
  const [originLon, originLat] = first;
  for (let i = 1; i < ring.length - 2; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    doubleArea += (a[0] - originLon) * (b[1] - originLat) -
      (b[0] - originLon) * (a[1] - originLat);
  }
  if (Math.abs(doubleArea) <= MIN_DOUBLE_AREA) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'El anillo no puede tener superficie nula.' });
  }
});

export const fieldBoundarySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(ringSchema).min(1).max(MAX_RINGS),
  srid: z.literal(4326).optional()
}).strict().superRefine((polygon, ctx) => {
  const count = polygon.coordinates.reduce((sum, ring) => sum + ring.length, 0);
  if (count > MAX_POINTS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coordinates'],
      message: `El perímetro admite hasta ${MAX_POINTS} puntos entre todos los anillos.` });
  }
});

// Even a closed, non-zero-area Polygon may intersect itself or contain invalid
// holes. Delegate actual topology to the same PostGIS engine that stores it.
// Query reads only the already-checked farm in the current FORCE RLS transaction.
export async function assertValidFieldBoundary(req, farmId, boundary) {
  if (boundary == null) return; // PATCH null clears an existing geometry.
  const geojson = JSON.stringify({ type: 'Polygon', coordinates: boundary.coordinates });
  const [shape] = await queryTenantTransaction(`
    SELECT ST_IsValid(ST_GeomFromGeoJSON(:geojson)) AS valid
    FROM farms
    WHERE tenant_id = :tenant AND id = :farm
  `, {
    type: QueryTypes.SELECT,
    transaction: req.dbTransaction,
    replacements: { geojson, tenant: req.tenantId, farm: farmId }
  });
  if (!shape?.valid) {
    throw new HttpError(422,
      'El perímetro del lote tiene intersecciones o anillos topológicamente inválidos.',
      { fieldErrors: { boundary: ['El polígono GeoJSON no es válido en PostGIS.'] } },
      'VALIDATION_ERROR');
  }
}
