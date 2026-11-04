import { scoutingPrivateViewScope } from './scoutingRunPresentation.js';
import { workOrderPrivateListScope } from './workOrderPrivateListScope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS = new Set(['draft','pending_approval','approved','assigned','in_progress','completed','cancelled']);
const TYPE = new Set(['application','sowing','fertilization','harvest','irrigation','inspection','other']);
const PRIORITY = new Set(['low','normal','high','urgent']);
const PUBLIC_COLUMNS = new Set([
  'scouting_observation_id', 'work_order_id', 'title', 'status', 'type', 'priority'
]);
export const MAX_OBSERVATION_ORDER_LINKS = 100;

export function observationWorkOrderLinkScope(session, dataMode) {
  if (dataMode !== 'live' ||
      !['tenant_admin','agronomic_coordinator'].includes(session?.membership?.roleCode)) {
    return null;
  }
  const scouting = scoutingPrivateViewScope(session, dataMode);
  const orders = workOrderPrivateListScope(session, dataMode);
  return scouting && orders ? JSON.stringify([scouting,orders]) : null;
}

// This endpoint must never be treated as a source of scouting notes, GPS,
// private photos, execution data, or the right to open another order.
// The order detail endpoint independently reauthorizes any selected ID.
export function checkedObservationWorkOrderLinks(response, runId, observations) {
  if (!UUID.test(runId || '') ||
      response?.data?.scoutingRunId !== runId ||
      !Array.isArray(observations) ||
      observations.some(item => !UUID.test(item?.id || ''))) {
    throw new Error('El servidor no confirmó los vínculos de esta recorrida.');
  }
  const rows = response?.data?.rows;
  if (!Array.isArray(rows) || rows.length > MAX_OBSERVATION_ORDER_LINKS) {
    throw new Error('El servidor devolvió un listado de vínculos inválido o incompleto.');
  }
  const known = new Set(observations.map(item => item.id));
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).some(key => !PUBLIC_COLUMNS.has(key)) ||
        !UUID.test(row.work_order_id || '') ||
        !UUID.test(row.scouting_observation_id || '') ||
        !known.has(row.scouting_observation_id) ||
        seen.has(row.work_order_id) ||
        typeof row.title !== 'string' || !row.title.trim() || row.title.length > 180 ||
        !STATUS.has(row.status) || !TYPE.has(row.type) || !PRIORITY.has(row.priority)) {
      throw new Error('El servidor devolvió vínculos de órdenes ajenos o inválidos.');
    }
    seen.add(row.work_order_id);
  }
  return rows;
}

export function visibleObservationWorkOrderLinks(snapshot, scope, api, runId, revision) {
  return scope && snapshot?.scope === scope && snapshot?.api === api &&
    snapshot?.runId === runId && snapshot?.revision === revision ? snapshot : null;
}
