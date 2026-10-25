import { sessionScope } from './offlineSyncModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_ROLES = new Set(['tenant_admin', 'agronomic_coordinator']);
const STATUSES = new Set(['active', 'inactive', 'archived']);

// A UI privacy and stale-async guard only; gis.write and FORCE RLS live on server.
export function fieldCreateScope(session, dataMode, preselectedFarmId) {
  if (dataMode !== 'live' || session?.authenticated !== true ||
      (preselectedFarmId && !UUID.test(preselectedFarmId))) return null;
  const principal = sessionScope(session);
  const role = session?.membership?.roleCode;
  if (!principal || !CREATE_ROLES.has(role) ||
      !Array.isArray(session?.entitlements) || !session.entitlements.includes('gis')) return null;
  const entitlements = [...new Set(session.entitlements.filter(x => typeof x === 'string'))].sort();
  return JSON.stringify([principal, session.membership?.id || '', role, entitlements, preselectedFarmId || '']);
}

export function prepareFieldCreate(form, farms, tenantId, preselectedFarmId) {
  const farmId = preselectedFarmId || form?.farm_id;
  if (!UUID.test(farmId || '') || !UUID.test(tenantId || '')) {
    throw new Error('Seleccioná un establecimiento válido de la empresa activa.');
  }
  if (!preselectedFarmId) {
    if (!Array.isArray(farms) || !farms.some(farm =>
      farm?.id === farmId && (!farm.tenant_id || farm.tenant_id === tenantId))) {
      throw new Error('El establecimiento no está disponible en esta empresa.');
    }
  }
  const name = typeof form?.name === 'string' ? form.name.trim() : '';
  if (name.length < 1 || name.length > 180) {
    throw new Error('El nombre del lote debe tener entre 1 y 180 caracteres.');
  }
  if (!STATUSES.has(form?.status)) throw new Error('El estado del lote no es válido.');
  const rawArea = String(form?.area_hectares ?? '').trim();
  if (rawArea && (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(rawArea) ||
      !Number.isFinite(Number(rawArea)) || Number(rawArea) > 9999999999.99)) {
    throw new Error('La superficie debe ser un número no negativo con hasta dos decimales.');
  }
  if (form?.notes != null && typeof form.notes !== 'string') {
    throw new Error('Las notas del lote deben ser texto.');
  }
  const notes = form?.notes?.trim() ?? '';
  return {
    farm_id: farmId, name, area_hectares: rawArea ? Number(rawArea) : 0,
    status: form.status,
    ...(notes ? { notes } : {})
  };
}

export function verifyCreatedField(response, requested, tenantId) {
  const row = response?.data;
  const hectares = row?.area_hectares == null ? NaN : Number(row.area_hectares);
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      typeof row.id !== 'string' || !UUID.test(row.id) ||
      row.tenant_id !== tenantId ||
      row.farm_id !== requested?.farm_id ||
      row.name !== requested.name || row.status !== requested.status ||
      !Number.isFinite(hectares) || hectares !== requested.area_hectares ||
      (row.notes ?? null) !== (requested.notes ?? null)) {
    throw new Error('El servidor no confirmó el lote solicitado. Revisá el establecimiento antes de crear otro.');
  }
  return row;
}

// The POST /fields endpoint has no durable idempotency token. A dispatched
// request retains its ticket after either success or an ambiguous response.
export function createFieldSubmitGate() {
  let active = null;
  let sequence = 0;
  return Object.freeze({
    acquire(scope) {
      if (!scope || active) return null;
      const ticket = Object.freeze({ scope, id: ++sequence });
      active = { ticket, phase: 'pending' };
      return ticket;
    },
    isCurrent(ticket) { return Boolean(ticket && active?.ticket === ticket); },
    isPending(scope) { return Boolean(active && active.ticket.scope === scope && active.phase === 'pending'); },
    isBlocked(scope) { return Boolean(active && active.ticket.scope === scope); },
    finish(ticket, phase) {
      if (!ticket || active?.ticket !== ticket) return false;
      if (phase !== 'confirmed' && phase !== 'uncertain') throw new Error('Estado de lote inválido.');
      active.phase = phase;
      return true;
    },
    reset() { sequence++; active = null; }
  });
}
