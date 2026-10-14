// GPS capture is opt-in. Neither this module nor the calling UI starts
// continuous position watching or stores a location without an explicit click.
export const FIELD_GPS_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15000
});
export const MAX_FIELD_ACCURACY_METERS = 150;
export const MAX_FIX_AGE_MS = 120000;

export function validateObservationPoint(point) {
  if (!point || typeof point !== 'object' || Array.isArray(point) ||
      point.type !== 'Point' || Object.keys(point).sort().join(',') !== 'coordinates,type' ||
      !Array.isArray(point.coordinates) || point.coordinates.length !== 2 ||
      !point.coordinates.every(v => typeof v === 'number' && Number.isFinite(v)) ||
      point.coordinates[0] < -180 || point.coordinates[0] > 180 ||
      point.coordinates[1] < -90 || point.coordinates[1] > 90) {
    throw new Error('La ubicación no contiene coordenadas WGS84 válidas.');
  }
  return { type: 'Point', coordinates: [...point.coordinates] };
}

export function confirmedFieldLocation(position, now = Date.now()) {
  const longitude = position?.coords?.longitude;
  const latitude = position?.coords?.latitude;
  const accuracy = position?.coords?.accuracy;
  const timestamp = position?.timestamp;
  const point = validateObservationPoint({
    type: 'Point', coordinates: [longitude, latitude]
  });
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    throw new Error('El dispositivo no informó una precisión GPS válida.');
  }
  if (accuracy > MAX_FIELD_ACCURACY_METERS) {
    throw new Error(`Precisión insuficiente (±${Math.round(accuracy)} m). Reintentá en un lugar despejado.`);
  }
  if (!Number.isFinite(timestamp) || timestamp > now + 5000 ||
      now - timestamp > MAX_FIX_AGE_MS) {
    throw new Error('La ubicación del dispositivo no es reciente. Volvé a solicitarla.');
  }
  return {
    point,
    accuracyMeters: Math.round(accuracy),
    capturedAt: new Date(timestamp).toISOString()
  };
}

export function fieldGpsErrorMessage(error) {
  switch (error?.code) {
    case 1: return 'Permiso de ubicación denegado. Podés habilitarlo en el navegador o guardar sin GPS.';
    case 2: return 'El dispositivo no pudo determinar tu ubicación. Podés reintentar o guardar sin GPS.';
    case 3: return 'Se agotó el tiempo para obtener GPS. Podés reintentar o guardar sin GPS.';
    default: return error?.message || 'No fue posible obtener una ubicación GPS verificable.';
  }
}
