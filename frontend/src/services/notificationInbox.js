import { canNavigateView } from './navigationAccess.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const DESTINATIONS = Object.freeze({
  scouting_run: 'scouting',
  work_order: 'orders'
});

export function notificationScope(session, dataMode) {
  if (dataMode !== 'live' || session?.authenticated !== true ||
      !session?.tenant?.id || !session?.user?.id) return null;
  return `${session.tenant.id}:${session.user.id}`;
}

function isValidRow(item, session) {
  return item && typeof item === 'object' && !Array.isArray(item) &&
    typeof item.id === 'string' && UUID.test(item.id) &&
    item.tenant_id === session.tenant.id && item.user_id === session.user.id &&
    typeof item.type === 'string' && item.type.length > 0 &&
    typeof item.title === 'string' && item.title.trim().length > 0 &&
    (item.body == null || typeof item.body === 'string') &&
    (item.read_at == null || Number.isFinite(Date.parse(item.read_at))) &&
    typeof item.created_at === 'string' && Number.isFinite(Date.parse(item.created_at));
}

// Fail closed if the payload is malformed or contains records for another
// user/tenant, rather than leaking a mixed inbox or displaying false zeroes.
export function parseNotificationList(response, session) {
  if (!notificationScope(session, 'live') || !Array.isArray(response?.data) ||
      response.data.length > 50 || response.data.some(item => !isValidRow(item, session)) ||
      new Set(response.data.map(item => item.id)).size !== response.data.length) {
    throw new Error('No se pudo verificar la bandeja de notificaciones de esta cuenta.');
  }
  return response.data;
}

export function parseReadReceipt(response, original, session) {
  const row = response?.data;
  if (!isValidRow(row, session) || row.id !== original?.id || !row.read_at) {
    throw new Error('El servidor no confirmó que esta notificación quedó leída.');
  }
  return row;
}

export function unreadNotifications(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, row) => sum + (row.read_at ? 0 : 1), 0);
}

export function notificationDestination(note, access) {
  const view = DESTINATIONS[note?.entity_type];
  if (!view || !UUID.test(String(note?.entity_id || '')) ||
      !canNavigateView(view, access)) return null;
  return { view, id: note.entity_id };
}
