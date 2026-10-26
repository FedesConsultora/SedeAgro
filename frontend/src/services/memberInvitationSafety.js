import { teamPrivateListScope } from './teamPrivateListScope.js';

export const MEMBER_INVITE_ROLES = Object.freeze([
  'scout', 'contractor', 'agronomic_coordinator', 'producer_viewer'
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^([0-9a-f-]{36})\.([a-f0-9]{64})$/i;

export function memberInviteAuthority(session, dataMode) {
  const scope = teamPrivateListScope(session, dataMode);
  return dataMode === 'live' && scope && session?.membership?.roleCode === 'tenant_admin' &&
    UUID.test(session?.tenant?.id || '') ? scope : null;
}

export function prepareMemberInvitation(form, session, dataMode) {
  const scope = memberInviteAuthority(session, dataMode);
  if (!scope) throw new Error('Solo un administrador autenticado puede invitar integrantes.');
  const email = typeof form?.email === 'string' ? form.email.trim().toLowerCase() : '';
  const roleCode = form?.roleCode;
  if (email.length > 320 || !EMAIL.test(email)) throw new Error('Ingresá un email válido.');
  if (!MEMBER_INVITE_ROLES.includes(roleCode)) throw new Error('El rol elegido no está permitido.');
  return { scope, tenantId: session.tenant.id,
    body: Object.freeze({ email, roleCode }) };
}

export function confirmMemberInvitation(response, request) {
  const row = response?.data;
  const token = response?.delivery?.token;
  const match = typeof token === 'string' && TOKEN.exec(token);
  if (!row || !UUID.test(row.id || '') ||
      row.email?.toLowerCase() !== request.body.email ||
      row.roleCode !== request.body.roleCode || row.status !== 'pending' ||
      response.delivery?.channel !== 'manual' ||
      response.delivery?.delivered !== false ||
      !match || match[1].toLowerCase() !== request.tenantId.toLowerCase() ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) <= Date.now() ||
      Date.parse(row.expiresAt) > Date.now() + 8 * 86400000) {
    throw new Error('El servidor no confirmó la invitación para esta empresa. No compartas un código no verificado.');
  }
  return { invitation: row, secret: token };
}

export function checkedMemberInvitations(response) {
  const rows = response?.data;
  if (!Array.isArray(rows) || rows.length > 100 || rows.some(row =>
    !row || typeof row !== 'object' || !UUID.test(row.id || '') ||
    typeof row.email !== 'string' || !EMAIL.test(row.email) ||
    !MEMBER_INVITE_ROLES.includes(row.roleCode) ||
    !['pending', 'accepted', 'revoked'].includes(row.status) ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    Object.hasOwn(row, 'token') || Object.hasOwn(row, 'tokenHash'))) {
    throw new Error('El servidor devolvió invitaciones inválidas o con datos secretos.');
  }
  return rows;
}

export function createMemberInviteGate() {
  let busy = false;
  return {
    acquire() { if (busy) return false; busy = true; return true; },
    release() { busy = false; },
    busy() { return busy; }
  };
}

export function confirmMemberActivation(response, submittedToken) {
  const tokenMatch = typeof submittedToken === 'string' && TOKEN.exec(submittedToken);
  const data = response?.data;
  if (!tokenMatch || !UUID.test(tokenMatch[1]) ||
      response?.next !== 'login' || !UUID.test(data?.id || '') ||
      !UUID.test(data?.tenant?.id || '') ||
      tokenMatch[1].toLowerCase() !== data.tenant.id.toLowerCase() ||
      typeof data.tenant.name !== 'string' || !data.tenant.name.trim() ||
      !MEMBER_INVITE_ROLES.includes(data.roleCode)) {
    throw new Error('El servidor no confirmó la activación para esta empresa.');
  }
  return { tenantName: data.tenant.name, role: data.roleCode };
}
