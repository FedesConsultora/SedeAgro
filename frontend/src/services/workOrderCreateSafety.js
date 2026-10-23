import { sessionScope } from './offlineSyncModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_ROLES = new Set(['tenant_admin', 'agronomic_coordinator']);

// The server is authoritative. Client identity is a render and async boundary,
// not a substitute for orders.write / tenant FORCE RLS.
export function workOrderCreateScope(session, dataMode) {
  if (dataMode === 'mock') return 'demo';
  const principal = dataMode === 'live' && session?.authenticated === true
    ? sessionScope(session) : null;
  const role = session?.membership?.roleCode;
  if (!principal || !CREATE_ROLES.has(role) ||
      !session?.entitlements?.includes('work_orders')) return null;
  return JSON.stringify([principal, role,
    [...new Set(session.entitlements.filter(value => typeof value === 'string'))].sort()]);
}

export function verifyCreatedWorkOrder(response, body, actorId) {
  const data = response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      typeof data.id !== 'string' || !UUID.test(data.id) ||
      !actorId || data.requested_by !== actorId ||
      data.field_id !== body?.field_id || data.type !== body?.type ||
      data.priority !== body?.priority || data.title !== body?.title ||
      data.status !== 'draft') {
    throw new Error('El servidor no confirmó la orden solicitada. Revisá Órdenes antes de crear otra.');
  }
  return data;
}

// This API does NOT offer a client idempotency key on work-order creation.
// Until the modal is closed, *any* dispatched POST holds its ticket, even on
// transport failure: an ACK may be lost after the database committed a row.
export function createWorkOrderSubmitGate() {
  let active = null;
  let sequence = 0;
  return Object.freeze({
    acquire(scope) {
      if (!scope || active) return null;
      const ticket = Object.freeze({scope, id: ++sequence});
      active = {ticket, phase: 'pending'};
      return ticket;
    },
    isCurrent(ticket) { return Boolean(ticket && active?.ticket === ticket); },
    isPending(scope) { return Boolean(active && active.ticket.scope === scope && active.phase === 'pending'); },
    isBlocked(scope) { return Boolean(active && active.ticket.scope === scope); },
    finish(ticket, phase) {
      if (!ticket || active?.ticket !== ticket) return false;
      if (phase === 'preflight-rejected') active = null;
      else if (phase === 'confirmed' || phase === 'uncertain') active.phase = phase;
      else throw new Error('Estado de creación inválido.');
      return true;
    },
    reset() {
      ++sequence;
      active = null;
    }
  });
}
