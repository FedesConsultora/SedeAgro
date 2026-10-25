import { sessionScope } from './offlineSyncModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(['tenant_admin', 'agronomic_coordinator']);
const LIMITS = { name: 180, locality: 140, province: 140, country: 80 };

export function farmCreateScope(session, dataMode) {
  if (dataMode !== 'live' || session?.authenticated !== true) return null;
  const principal = sessionScope(session);
  const membership = session?.membership;
  if (!principal || !ROLES.has(membership?.roleCode) ||
      !Array.isArray(session?.entitlements) || !session.entitlements.includes('gis')) return null;
  return JSON.stringify([
    principal, membership?.id || '', membership.roleCode,
    [...new Set(session.entitlements.filter(e => typeof e === 'string'))].sort()
  ]);
}

function boundedText(value, key, required = false) {
  if (value != null && typeof value !== 'string') {
    throw new Error('El campo ' + key + ' debe ser texto.');
  }
  const text = (value || '').trim();
  if (text.length > (LIMITS[key] || 5000) || (required && text.length < 2)) {
    throw new Error('Revisá el campo ' + key + '.');
  }
  return text;
}

export function prepareFarmCreate(form, producers, tenantId) {
  if (!UUID.test(tenantId || '') || !Array.isArray(producers)) {
    throw new Error('No se pudo verificar la empresa y sus productores.');
  }
  const name = boundedText(form?.name, 'name', true);
  const locality = boundedText(form?.locality, 'locality');
  const province = boundedText(form?.province, 'province');
  const country = boundedText(form?.country, 'country') || 'Argentina';
  const notes = boundedText(form?.notes, 'notes');
  const producerId = form?.producer_id || null;
  if (producerId && (!UUID.test(producerId) || !producers.some(p =>
    p?.id === producerId && (!p.tenant_id || p.tenant_id === tenantId)))) {
    throw new Error('El productor seleccionado no pertenece a los autorizados de esta empresa.');
  }
  return Object.freeze({
    name, producer_id: producerId, country,
    ...(locality ? { locality } : {}),
    ...(province ? { province } : {}),
    ...(notes ? { notes } : {})
  });
}

export function verifyCreatedFarm(response, requested, tenantId) {
  const row = response?.data;
  const same = (key) => (row?.[key] ?? null) === (requested?.[key] ?? null);
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      !UUID.test(row.id || '') || row.tenant_id !== tenantId ||
      typeof response?.replayed !== 'boolean' ||
      !same('name') || !same('producer_id') || !same('country') ||
      !same('locality') || !same('province') || !same('notes')) {
    throw new Error('El servidor no confirmó el establecimiento solicitado. Revisá el listado antes de crear otro.');
  }
  return row;
}

// POST /farms has tenant+name uniqueness and safe same-payload replay.
// A retry is only user-initiated after an uncertain first POST, with the same
// immutable body and identical tenant/API identity. Never issue a fresh request
// from the draft after the transport outcome is unknown.
export function createFarmSubmitGate() {
  let active = null;
  let serial = 0;
  return Object.freeze({
    acquire(scope) {
      if (!scope || active) return null;
      const ticket = Object.freeze({ scope, id: ++serial });
      active = { ticket, phase: 'pending' };
      return ticket;
    },
    retry(scope) {
      if (!scope || active?.ticket.scope !== scope || active.phase !== 'uncertain') return null;
      const ticket = Object.freeze({ scope, id: ++serial });
      active = { ticket, phase: 'pending' };
      return ticket;
    },
    isCurrent(ticket) { return Boolean(ticket && active?.ticket === ticket); },
    isPending(scope) { return Boolean(active && active.ticket.scope === scope && active.phase === 'pending'); },
    isBlocked(scope) { return Boolean(active && active.ticket.scope === scope); },
    finish(ticket, phase) {
      if (!ticket || active?.ticket !== ticket) return false;
      if (!['confirmed', 'uncertain'].includes(phase)) throw new Error('Estado de creación inválido.');
      active.phase = phase;
      return true;
    },
    reset() { serial++; active = null; }
  });
}
