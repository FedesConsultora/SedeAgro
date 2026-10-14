// Stable business-event payloads. Do not include field notes, instructions,
// addresses, producer information, or arbitrary user-entered text in alerts.
// Authorization/tenant isolation is enforced by the calling transaction and
// the notification table's RLS and membership foreign key.
const ENTITY_TYPES = Object.freeze({
  scouting_run: { title: 'Nueva recorrida asignada', body: 'Tenés una recorrida asignada para revisar.' },
  work_order: { title: 'Nueva orden asignada', body: 'Tenés una orden de trabajo asignada para revisar.' }
});

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export const ORDER_RECIPIENT_ROLES = Object.freeze([
  'tenant_admin', 'agronomic_coordinator', 'contractor'
]);

export function shouldNotifyRunAssignment(previousUserId, nextUserId) {
  return typeof nextUserId === 'string' && UUID.test(nextUserId) &&
    nextUserId !== previousUserId;
}

export function assignmentNotice({ tenantId, userId, entityType, entityId }) {
  const display = ENTITY_TYPES[entityType];
  if (!display || ![tenantId, userId, entityId].every(value =>
      typeof value === 'string' && UUID.test(value))) {
    throw new Error('Asignación sin IDs verificados; no se generó notificación.');
  }
  return {
    tenant_id: tenantId,
    user_id: userId,
    type: 'assignment',
    title: display.title,
    body: display.body,
    entity_type: entityType,
    entity_id: entityId
  };
}
