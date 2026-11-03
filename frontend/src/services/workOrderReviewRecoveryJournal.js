import { createEncryptedCreateJournal } from './encryptedCreateJournal.js';

// Business IDs and review decisions are contained ONLY in AES-GCM ciphertext.
// IndexedDB scope is a SHA-256 opaque digest of the authenticated tenant,
// actor and order; the visible record ID is a random idempotency UUID.
// This is at-rest encryption, NOT authentication or XSS protection.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(['tenant_admin', 'agronomic_coordinator']);
const CHECKS = ['time_checked', 'area_checked', 'result_checked',
  'operation_checked', 'evidence_basis'];
const keysAre = (value, expected) => Boolean(value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key)));

function validReviewBody(item) {
  if (!item || !['verified', 'rejected'].includes(item.decision) ||
      !['client_request_id', 'tenant_id', 'reviewer_id', 'order_id', 'report_id']
        .every(key => UUID.test(item[key] || ''))) return false;
  const expected = ['client_request_id', 'tenant_id', 'reviewer_id',
    'order_id', 'report_id', 'decision',
    item.decision === 'verified' ? 'checklist' : 'reason'];
  if (!keysAre(item, expected)) return false;
  if (item.decision === 'rejected') {
    return typeof item.reason === 'string' &&
      item.reason === item.reason.trim() &&
      item.reason.length >= 10 && item.reason.length <= 500;
  }
  return keysAre(item.checklist, CHECKS) &&
    CHECKS.slice(0, 4).every(key => item.checklist[key] === true) &&
    ['reviewed_files', 'no_files'].includes(item.checklist.evidence_basis);
}

const journal = createEncryptedCreateJournal({
  databaseName: 'sedeagro-work-order-review-recovery-v1',
  aadDomain: 'sedeagro:work-order-review-recovery:v1:',
  validateBody: validReviewBody
});

function scopedIdentity(session, orderId) {
  if (session?.authenticated !== true ||
      session?.membership?.status !== 'active' ||
      !ROLES.has(session?.membership?.roleCode) ||
      !UUID.test(session?.tenant?.id || '') ||
      !UUID.test(session?.user?.id || '') || !UUID.test(orderId || '')) {
    throw new Error('Se necesita una sesión verificada de coordinación para recuperar revisiones.');
  }
  return {
    tenantId: session.tenant.id, reviewerId: session.user.id, orderId
  };
}

export async function reviewRecoveryScope(session, orderId) {
  const { tenantId, reviewerId } = scopedIdentity(session, orderId);
  if (!globalThis.crypto?.subtle) {
    throw new Error('El navegador no permite comprobar el cifrado del recibo local.');
  }
  const input = new TextEncoder().encode(
    `sedeagro:review-scope:v1:${tenantId}:${reviewerId}:${orderId}`);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', input);
  return 'review:' + [...new Uint8Array(hash)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromSealed(item, session, orderId) {
  if (!validReviewBody(item) || item.tenant_id !== session.tenant.id ||
      item.reviewer_id !== session.user.id || item.order_id !== orderId) {
    throw new Error('La revisión cifrada pertenece a otra empresa, usuario u orden.');
  }
  return Object.freeze({
    reportId: item.report_id,
    body: Object.freeze({
      client_request_id: item.client_request_id,
      decision: item.decision,
      ...(item.decision === 'verified'
        ? { checklist: Object.freeze({ ...item.checklist }) }
        : { reason: item.reason })
    })
  });
}

// READ is allowed only after /auth/me or real login authenticated this actor.
// An unreadable/corrupted row must block any new review; never delete silently.
export async function readPendingReview(session, orderId) {
  const scope = await reviewRecoveryScope(session, orderId);
  const record = await journal.read(scope);
  return record ? fromSealed(record.body, session, orderId) : null;
}

// MUST await the IndexedDB commit before issuing the first review POST.
// journal.save uses IDB add() under a unique scope: another tab cannot
// overwrite/restart the request with a different UUID.
export async function savePendingReview(session, orderId, reportId, body) {
  const { tenantId, reviewerId } = scopedIdentity(session, orderId);
  const scope = await reviewRecoveryScope(session, orderId);
  const item = {
    client_request_id: body?.client_request_id,
    tenant_id: tenantId, reviewer_id: reviewerId,
    order_id: orderId, report_id: reportId,
    decision: body?.decision,
    ...(body?.decision === 'verified'
      ? { checklist: body.checklist }
      : { reason: body?.reason })
  };
  if (!validReviewBody(item)) {
    throw new Error('La revisión no tiene un contenido válido para el guardado cifrado.');
  }
  await journal.save(scope, item);
  return fromSealed(item, session, orderId);
}

// Compare+delete is atomic; an old tab cannot erase the newer request.
export async function discardPendingReview(session, orderId, requestId) {
  const scope = await reviewRecoveryScope(session, orderId);
  return journal.discard(scope, requestId);
}
