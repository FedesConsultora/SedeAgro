import { sessionScope } from './offlineSyncModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLANNER_ROLES = new Set(['tenant_admin', 'agronomic_coordinator']);

// A UI fence for stale tenant/actor/role responses, not an authorization grant.
// scouting.plan and FORCE RLS remain exclusively enforced by the backend.
export function scoutingRunCreateScope(session, dataMode) {
  if (dataMode !== 'live' || session?.authenticated !== true) return null;
  const principal = sessionScope(session);
  const role = session?.membership?.roleCode;
  if (!principal || !PLANNER_ROLES.has(role) ||
      !Array.isArray(session.entitlements) || !session.entitlements.includes('scouting')) return null;
  const entitlements = [...new Set(session.entitlements.filter(value => typeof value === 'string'))].sort();
  return JSON.stringify([principal, session.membership?.id || '', role, entitlements]);
}

export function verifyCreatedScoutingRun(response, requested, tenantId) {
  const run = response?.data;
  const matchesSchedule = requested?.scheduled_at
    ? (typeof run?.scheduled_at === 'string' &&
        Number.isFinite(Date.parse(run.scheduled_at)) &&
        Date.parse(run.scheduled_at) === Date.parse(requested.scheduled_at))
    : run?.scheduled_at == null;
  if (!run || typeof run !== 'object' || Array.isArray(run) ||
      typeof run.id !== 'string' || !UUID.test(run.id) ||
      !tenantId || run.tenant_id !== tenantId ||
      !requested || run.campaign_field_id !== requested.campaign_field_id ||
      (run.assigned_to ?? null) !== (requested.assigned_to ?? null) ||
      run.status !== requested.status ||
      !matchesSchedule ||
      (requested.summary === undefined ? run.summary != null : run.summary !== requested.summary)) {
    throw new Error('El servidor no confirmó la recorrida solicitada. Revisá Recorridas antes de crear otra.');
  }
  return run;
}

// POST /scouting/runs creates a new row without a client idempotency key.
// Keep the ticket sticky after any dispatched request, including lost ACK.
// A new modal may be used only after the operator checks the current run list.
export function createScoutingRunSubmitGate() {
  let active = null;
  let serial = 0;
  return Object.freeze({
    acquire(scope) {
      if (!scope || active) return null;
      const ticket = Object.freeze({ scope, id: ++serial });
      active = { ticket, phase: 'pending' };
      return ticket;
    },
    isCurrent(ticket) { return Boolean(ticket && active?.ticket === ticket); },
    isPending(scope) { return Boolean(active && active.ticket.scope === scope && active.phase === 'pending'); },
    isBlocked(scope) { return Boolean(active && active.ticket.scope === scope); },
    finish(ticket, phase) {
      if (!ticket || active?.ticket !== ticket) return false;
      if (phase === 'preflight-rejected') active = null;
      else if (phase === 'confirmed' || phase === 'uncertain') active.phase = phase;
      else throw new Error('Estado inválido de creación de recorrida.');
      return true;
    },
    reset() {
      ++serial;
      active = null;
    }
  });
}
