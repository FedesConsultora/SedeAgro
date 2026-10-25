import { sessionScope } from './offlineSyncModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLANNERS = new Set(['tenant_admin', 'agronomic_coordinator']);
const STATUSES = new Set(['planned', 'active', 'closed']);

// UI scope only: campaigns.write, tenant isolation and RLS are checked by the API.
export function campaignCreateScope(session, dataMode) {
  if (dataMode !== 'live' || session?.authenticated !== true) return null;
  const principal = sessionScope(session);
  const membership = session?.membership;
  if (!principal || !membership?.id || !PLANNERS.has(membership.roleCode) ||
      !Array.isArray(session?.entitlements) || !session.entitlements.includes('campaigns')) {
    return null;
  }
  const entitlements = [...new Set(session.entitlements.filter(x => typeof x === 'string'))].sort();
  return JSON.stringify([principal, membership.id, membership.roleCode, entitlements]);
}

// Do not use Date.parse on browser-local dates: it can silently normalize
// impossible days. DATEONLY is a calendar day, not a UTC instant for the user.
function validDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function prepareCampaignCreate(form) {
  const name = typeof form?.name === 'string' ? form.name.trim() : '';
  if (name.length < 2 || name.length > 160) {
    throw new Error('El nombre de campaña debe tener entre 2 y 160 caracteres.');
  }
  const yearText = String(form?.season_year ?? '');
  const year = Number(yearText);
  if (!/^\d{4}$/.test(yearText) || !Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('El año de campaña debe estar entre 2000 y 2100.');
  }
  if (!STATUSES.has(form?.status)) {
    throw new Error('Elegí un estado de campaña válido.');
  }
  if (!validDateOnly(form?.starts_at)) {
    throw new Error('La fecha de inicio de campaña no es válida.');
  }
  const endsAt = form?.ends_at ?? '';
  if (endsAt !== '' && !validDateOnly(endsAt)) {
    throw new Error('La fecha de fin de campaña no es válida.');
  }
  if (endsAt && endsAt < form.starts_at) {
    throw new Error('La fecha de fin de campaña no puede ser anterior al inicio.');
  }
  return {
    name,
    season_year: year,
    starts_at: form.starts_at,
    ...(endsAt ? { ends_at: endsAt } : {}),
    status: form.status
  };
}

export function verifyCreatedCampaign(response, requested, tenantId) {
  const data = response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      typeof data.id !== 'string' || !UUID.test(data.id) ||
      !tenantId || data.tenant_id !== tenantId ||
      !requested || (requested.client_request_id !== undefined &&
        (typeof requested.client_request_id !== 'string' ||
         !UUID.test(requested.client_request_id) ||
         typeof response.replayed !== 'boolean')) ||
      data.name !== requested.name ||
      data.season_year !== requested.season_year ||
      data.starts_at !== requested.starts_at ||
      (data.ends_at ?? null) !== (requested.ends_at ?? null) ||
      data.status !== requested.status) {
    throw new Error('El servidor no confirmó la campaña solicitada. Revisá Campañas antes de crear otra.');
  }
  return data;
}

// Backend now accepts durable actor/tenant scoped client_request_id.
// Only a user-initiated retry from uncertain state can resend the SAME key
// and immutable body. acquire() still blocks any changed or duplicate POST.
export function createCampaignSubmitGate() {
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
      if (phase === 'preflight-rejected') active = null;
      else if (phase === 'confirmed' || phase === 'uncertain') active.phase = phase;
      else throw new Error('Estado de alta de campaña inválido.');
      return true;
    },
    reset() {
      ++serial;
      active = null;
    }
  });
}
