import { teamPrivateListScope } from './teamPrivateListScope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(['scout','contractor','agronomic_coordinator','producer_viewer']);

export function memberLifecycleAuthority(session, dataMode) {
  const scope = teamPrivateListScope(session, dataMode);
  return dataMode === 'live' && scope &&
    session?.membership?.roleCode === 'tenant_admin' &&
    UUID.test(session?.tenant?.id || '') && UUID.test(session?.user?.id || '')
    ? scope : null;
}

export function canManageMember(member, session, dataMode) {
  return Boolean(memberLifecycleAuthority(session,dataMode) &&
    member?.tenant_id === session.tenant.id &&
    UUID.test(member.id || '') && UUID.test(member.user_id || '') &&
    member.user_id !== session.user.id &&
    ALLOWED_ROLES.has(member.role_code) &&
    ['active','blocked'].includes(member.status));
}

export function prepareMemberStatus(member, status, session, dataMode) {
  const scope = memberLifecycleAuthority(session,dataMode);
  if (!canManageMember(member,session,dataMode) ||
      !['active','blocked'].includes(status) || member.status === status) {
    throw new Error('No está permitido cambiar este integrante.');
  }
  return { scope, tenantId: session.tenant.id, id: member.id, userId: member.user_id,
    roleCode: member.role_code, status };
}

export function confirmMemberStatus(response, expected) {
  const row = response?.data;
  if (!row || row.id !== expected.id || row.tenant_id !== expected.tenantId ||
      row.user_id !== expected.userId || row.role_code !== expected.roleCode ||
      row.status !== expected.status || typeof row.changed !== 'boolean') {
    throw new Error('No se confirmó el cambio de permisos para este integrante.');
  }
  return row;
}
