import { sessionScope } from './offlineSyncModel.js';

const RUN_UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const STATES = new Set(['pending', 'conflict', 'auth']);
const TYPES = Object.freeze({
  weed: 'Maleza', pest: 'Plaga', disease: 'Enfermedad', phenology: 'Fenología',
  nutrition: 'Nutrición', water: 'Agua', general: 'General'
});
const SEVERITIES = Object.freeze({
  low: 'Leve', medium: 'Moderada', high: 'Alta', critical: 'Crítica'
});

export const LOCAL_CAPTURE_PHASES = Object.freeze({
  observation_pending: {
    label: 'Observación pendiente de confirmación',
    help: 'La captura sigue en este dispositivo; todavía no se confirmó su aplicación en PostgreSQL.'
  },
  photo_pending: {
    label: 'Observación aplicada · fotografía pendiente',
    help: 'El recibo previo confirmó la observación. Falta la confirmación independiente de su fotografía.'
  },
  review: {
    label: 'Requiere revisión de sincronización',
    help: 'La operación necesita intervención. Revisá la causa en Sincronizaciones sin generar una captura nueva.'
  },
  authorization: {
    label: 'Sesión no autorizada para reenviar',
    help: 'Se necesita iniciar sesión con la cuenta y empresa correctas; la captura local se conserva.'
  }
});

export function runLocalCaptureSummary(rows, session, runId) {
  const scope = sessionScope(session);
  if (!scope || !RUN_UUID.test(String(runId))) {
    throw new Error('No hay cuenta, empresa o recorrida verificable para consultar capturas locales.');
  }
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new Error('La cola offline no devolvió una lista válida de capturas.');
  }
  const matches = [];
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      row.scope !== scope || typeof row.id !== 'string' ||
      !row.id.startsWith(`${scope}:`) ||
      row.body?.idempotency_key !== row.idempotencyKey ||
      !RUN_UUID.test(String(row.idempotencyKey)) ||
      !STATES.has(row.state)) {
      throw new Error('Las capturas locales no corresponden a la cuenta activa o están dañadas.');
    }
    if (row.runId !== runId) continue;
    if (ids.has(row.id)) throw new Error('Hay identificadores locales duplicados en esta recorrida.');
    ids.add(row.id);
    const operation = row.body?.operations?.[0];
    if (row.body.operations.length !== 1 ||
      operation?.entity_type !== 'scouting_observation' ||
      operation?.operation !== 'create' ||
      operation?.payload?.scouting_run_id !== runId ||
      typeof operation?.entity_client_id !== 'string') {
      throw new Error('La captura local contiene una operación incompatible con esta recorrida.');
    }
    const withPhoto = Boolean(row.evidence);
    const photoOnly = withPhoto && RUN_UUID.test(String(row.syncedObservationId || ''));
    const phase = row.state === 'auth' ? 'authorization'
      : row.state === 'conflict' ? 'review'
        : photoOnly ? 'photo_pending' : 'observation_pending';
    const created = Date.parse(row.createdAt);
    matches.push({
      id: row.id,
      phase,
      state: row.state,
      typeLabel: TYPES[operation.payload?.observation_type] || 'Observación',
      severityLabel: SEVERITIES[operation.payload?.severity] || 'Sin severidad',
      createdAt: Number.isFinite(created) ? row.createdAt : null,
      hasPhoto: withPhoto,
      hasGps: operation.payload?.point?.type === 'Point',
      observationConfirmed: photoOnly
    });
  }
  matches.sort((a, b) => {
    const byDate = (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
    return byDate || a.id.localeCompare(b.id);
  });
  return {
    entries: matches,
    total: matches.length,
    pendingObservations: matches.filter(row => !row.observationConfirmed).length,
    pendingPhotos: matches.filter(row => row.observationConfirmed).length,
    review: matches.filter(row => row.state === 'auth' || row.state === 'conflict').length,
    withGps: matches.filter(row => row.hasGps).length
  };
}
