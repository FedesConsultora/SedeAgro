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
    !Number.isFinite(Date.parse(row.updatedAt)) ||
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


// Lost manual codes cannot be recovered. An explicit rotation invalidates
// the old token. The revision protects against another administrator having
// already renewed it; client state never grants a membership.
export function prepareMemberInviteRotation(row, session, dataMode) {
  const scope = memberInviteAuthority(session, dataMode);
  if (!scope) throw new Error('Solo la administración de empresa puede renovar invitaciones.');
  if (!row || !UUID.test(row.id || '') || row.status !== 'pending' ||
      !MEMBER_INVITE_ROLES.includes(row.roleCode) ||
      typeof row.email !== 'string' || !EMAIL.test(row.email) ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) <= Date.now() ||
      typeof row.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(row.updatedAt))) {
    throw new Error('La invitación ya no está pendiente o no puede renovarse.');
  }
  return Object.freeze({ scope, tenantId: session.tenant.id, id: row.id,
    email: row.email, roleCode: row.roleCode,
    expectedUpdatedAt: row.updatedAt });
}

export function confirmMemberInviteRotation(response, prepared) {
  const confirmed = confirmMemberInvitation(response, {
    tenantId: prepared.tenantId,
    body: { email: prepared.email, roleCode: prepared.roleCode }
  });
  if (confirmed.invitation.id !== prepared.id ||
      !Number.isFinite(Date.parse(confirmed.invitation.updatedAt)) ||
      Date.parse(confirmed.invitation.updatedAt) <= Date.parse(prepared.expectedUpdatedAt)) {
    throw new Error('El servidor no confirmó la renovación exacta. No compartas el código.');
  }
  return confirmed;
}
