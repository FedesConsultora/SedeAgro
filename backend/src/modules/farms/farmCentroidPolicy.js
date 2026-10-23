// 0U.17 — accept only explicitly authored WGS84 GeoJSON farm centroids.
// This matches PostGIS geometry(Point,4326) and the frontend's [longitude, latitude] contract.
// Null remains allowed so a misplaced centroid can be cleared without moving its farm.
import { z } from 'zod';

export const farmCentroidSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90)
  ]),
  srid: z.literal(4326).optional()
}).strict();
