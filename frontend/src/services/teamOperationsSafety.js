// Client-only guards for live team management. Server teams.write, active
// membership checks and FORCE RLS remain the sole authorization authority.
import { teamPrivateListScope } from './teamPrivateListScope.js';

const SCOPES = Object.freeze(['field_ops', 'agronomy', 'contractor', 'client', 'support']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = value => typeof value === 'string'
  ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
const textValid = (value, max) => value.length >= 2 && value.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

export const TEAM_SCOPES = SCOPES;

export function liveTeamAuthority(session, dataMode) {
  if (dataMode !== 'live' || !['tenant_admin', 'agronomic_coordinator']
    .includes(session?.membership?.roleCode)) return null;
  return teamPrivateListScope(session, dataMode);
}

export function prepareLiveTeamCreation(value, authority) {
  if (!authority) throw new Error('Sin permisos para crear equipos.');
  const name = clean(value?.name);
  if (!textValid(name, 160)) throw new Error('Ingresá un nombre de equipo válido (2 a 160 caracteres).');
  const scope = value?.scope;
  if (!SCOPES.includes(scope)) throw new Error('Alcance de equipo inválido.');
  return { name, scope };
}

export function confirmLiveTeamCreation(response, request, tenantId) {
  const item = response?.data;
  if (!UUID.test(item?.id || '') || item.tenant_id !== tenantId ||
      item.name !== request.name || item.scope !== request.scope ||
      item.farm_id != null || item.notes != null ||
      (response.replayed !== undefined && typeof response.replayed !== 'boolean')) {
    throw new Error('El servidor no confirmó la identidad y el alcance del equipo.');
  }
  return item;
}

export function eligibleTeamMembers(members, team) {
  if (!team) return [];
  const existing = new Set((team.TeamMembers || []).map(row => row.user_id));
  return (members || []).filter(member =>
    member?.status === 'active' && member.User?.status === 'active' &&
    UUID.test(member.user_id || '') && member.User.id === member.user_id &&
    !existing.has(member.user_id));
}

export function prepareLiveTeamMember(value, teams, members, authority) {
  if (!authority) throw new Error('Sin permisos para integrar equipos.');
  const team = teams.find(item => item.id === value?.teamId);
  if (!team) throw new Error('Elegí un equipo de esta empresa.');
  const member = eligibleTeamMembers(members, team).find(item => item.user_id === value?.userId);
  if (!member) throw new Error('Elegí un integrante activo que todavía no pertenezca al equipo.');
  const roleLabel = clean(value?.roleLabel);
  if (!textValid(roleLabel, 80)) throw new Error('Ingresá una función válida (2 a 80 caracteres).');
  return { teamId: team.id, body: { user_id: member.user_id, role_label: roleLabel } };
}

export function confirmLiveTeamMember(response, expected, tenantId) {
  const item = response?.data;
  if (!UUID.test(item?.id || '') || item.tenant_id !== tenantId ||
      item.team_id !== expected.teamId || item.user_id !== expected.body.user_id ||
      item.role_label !== expected.body.role_label) {
    throw new Error('El servidor no confirmó a quién agregó y a qué equipo.');
  }
  return item;
}
