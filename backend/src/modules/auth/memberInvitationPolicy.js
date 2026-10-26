import { createHash, randomBytes } from 'node:crypto';

// A role is never chosen from the caller's arbitrary JSON or inherited from
// a different tenant. Tenant administrators cannot mint platform/admin roles.
export const INVITABLE_MEMBER_ROLES = Object.freeze([
  'scout', 'contractor', 'agronomic_coordinator', 'producer_viewer'
]);
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^([0-9a-f-]{36})\.([a-f0-9]{64})$/i;

export function newInvitationToken(tenantId, secret = randomBytes(32).toString('hex')) {
  if (!UUID.test(tenantId) || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error('Invalid invitation token inputs.');
  }
  return `${tenantId}.${secret}`;
}

export function invitationTokenIdentity(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length > 110) return null;
  const found = TOKEN.exec(rawToken);
  if (!found || !UUID.test(found[1])) return null;
  return {
    tenantId: found[1].toLowerCase(),
    tokenHash: createHash('sha256').update(rawToken, 'utf8').digest('hex')
  };
}

export function isInvitableRole(role) {
  return INVITABLE_MEMBER_ROLES.includes(role);
}

export function normalizeInvitationEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function hasMemberCapacity(active, pending, maxUsers) {
  return Number.isSafeInteger(active) && active >= 0 &&
    Number.isSafeInteger(pending) && pending >= 0 &&
    Number.isSafeInteger(maxUsers) && maxUsers > 0 &&
    active + pending < maxUsers;
}

export function invitationPublicShape(invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    roleCode: invitation.role_code,
    status: invitation.status,
    expiresAt: invitation.expires_at,
    createdAt: invitation.created_at
  };
}
