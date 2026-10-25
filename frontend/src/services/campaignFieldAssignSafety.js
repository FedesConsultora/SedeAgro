import { sessionScope } from './offlineSyncModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(['tenant_admin', 'agronomic_coordinator']);
const STATUSES = new Set(['planned', 'active']);

// UI snapshot fencing only. Server campaigns.write, tenant RLS and FKs
// remain authoritative for membership, crop varieties and persistence.
export function campaignFieldAssignScope(session, dataMode, campaignId) {
  if (dataMode !== 'live' || session?.authenticated !== true ||
      !UUID.test(campaignId || '')) return null;
  const principal = sessionScope(session);
  const role = session?.membership?.roleCode;
  if (!principal || !ROLES.has(role) || !Array.isArray(session?.entitlements) ||
      !session.entitlements.includes('campaigns')) return null;
  const entitlements = [...new Set(session.entitlements.filter(e => typeof e === 'string'))].sort();
  return JSON.stringify([principal, session.membership?.id || '', role, entitlements, campaignId]);
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = +value.slice(0, 4);
  const month = +value.slice(5, 7);
  const day = +value.slice(8, 10);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function prepareCampaignFieldAssignment(form, fields, crops, tenantId) {
  if (!Array.isArray(fields) || !Array.isArray(crops) || !UUID.test(tenantId || '')) {
    throw new Error('No se pudieron verificar los lotes y cultivos de esta empresa.');
  }
  const field = fields.find(x => x?.id === form?.field_id);
  const crop = crops.find(x => x?.id === form?.crop_type_id);
  if (!field || (field.tenant_id && field.tenant_id !== tenantId)) {
    throw new Error('Seleccioná un lote disponible en esta empresa.');
  }
  if (!crop) throw new Error('Seleccioná un cultivo válido.');
  const varieties = crop.CropVarieties ?? crop.cropVarieties ?? [];
  if (!Array.isArray(varieties)) throw new Error('El catálogo de variedades es inválido.');
  if (form.crop_variety_id && !varieties.some(v => v?.id === form.crop_variety_id)) {
    throw new Error('La variedad no corresponde al cultivo elegido.');
  }
  if (!STATUSES.has(form.status)) throw new Error('Estado de lote de campaña inválido.');
  const planting = form.planting_date || '';
  const harvest = form.harvest_target_date || '';
  if ((planting && !calendarDate(planting)) || (harvest && !calendarDate(harvest))) {
    throw new Error('La fecha agrícola seleccionada es inválida.');
  }
  if (planting && harvest && harvest < planting) {
    throw new Error('La fecha de cosecha no puede ser anterior a la siembra.');
  }
  let yieldValue;
  if (form.expected_yield !== '' && form.expected_yield != null) {
    const raw = String(form.expected_yield);
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw) ||
        !Number.isFinite(Number(raw)) || Number(raw) > 9999999999.99) {
      throw new Error('El rendimiento esperado debe ser un número no negativo con hasta dos decimales.');
    }
    yieldValue = Number(raw);
  }
  return {
    field_id: form.field_id,
    crop_type_id: form.crop_type_id,
    ...(form.crop_variety_id ? { crop_variety_id: form.crop_variety_id } : {}),
    ...(planting ? { planting_date: planting } : {}),
    ...(harvest ? { harvest_target_date: harvest } : {}),
    ...(yieldValue === undefined ? {} : { expected_yield: yieldValue }),
    status: form.status
  };
}

export function verifyAssignedCampaignField(reply, sent, tenantId, campaignId) {
  const row = reply?.data;
  const hasYield = Object.hasOwn(sent || {}, 'expected_yield');
  const actualYield = row?.expected_yield == null ? null : Number(row.expected_yield);
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      typeof row.id !== 'string' || !UUID.test(row.id) ||
      row.tenant_id !== tenantId || row.campaign_id !== campaignId ||
      row.field_id !== sent?.field_id || row.crop_type_id !== sent?.crop_type_id ||
      (row.crop_variety_id ?? null) !== (sent.crop_variety_id ?? null) ||
      (row.planting_date ?? null) !== (sent.planting_date ?? null) ||
      (row.harvest_target_date ?? null) !== (sent.harvest_target_date ?? null) ||
      (hasYield ? !Number.isFinite(actualYield) || actualYield !== sent.expected_yield
        : row.expected_yield != null) ||
      row.status !== sent?.status) {
    throw new Error('El servidor no confirmó la asignación. Revisá la campaña antes de volver a asignar el lote.');
  }
  return row;
}

export function createCampaignFieldAssignGate() {
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
      if (phase === 'confirmed' || phase === 'uncertain') active.phase = phase;
      else throw new Error('Estado de asignación inválido.');
      return true;
    },
    reset() { serial++; active = null; }
  });
}
